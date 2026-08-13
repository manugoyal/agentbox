/**
 * Restricted, session-scoped access to a host Docker Engine.
 *
 * Why this exists
 * ---------------
 * A Docker socket is effectively a host root capability. Giving that socket
 * to a coding agent would let it mount arbitrary host paths, join host
 * namespaces, start privileged containers, or control containers belonging to
 * other users. SRT therefore never exposes the socket. This module runs on the
 * trusted side of SRT, opens a loopback-only HTTP endpoint, and puts that
 * endpoint in the sandbox as `DOCKER_HOST`.
 *
 * Trust model
 * -----------
 * The Docker client, coding agent, request bodies, and workload images are all
 * untrusted. This proxy and the local Docker daemon are trusted. The proxy is
 * a validating API gateway, not a transparent Docker forwarder: every route,
 * query parameter, request field, resource identifier, and upgraded stream
 * must be explicitly recognized. Unknown input fails closed. `docker-policy.ts`
 * reconstructs container and exec requests from the accepted fields so a new
 * Engine API field cannot silently become allowed after an upgrade.
 *
 * What a session may do
 * ---------------------
 * A session may anonymously pull arbitrary image references; create a bounded
 * number of containers from images it pulled itself; and perform the ordinary
 * lifecycle, inspection, logs, stats, attach, exec, archive-copy, and cleanup
 * operations needed by Docker CLI, Bollard, and Testcontainers clients. The
 * image's command, environment, user, and contents are intentionally not
 * prescribed. Containers may modify their own writable layer and communicate
 * freely with other containers created by the same agentbox session.
 *
 * What the proxy restricts
 * ------------------------
 * - Containers cannot request bind mounts, host or existing volumes,
 *   privileged mode, host networking or process namespaces, devices, added
 *   capabilities, custom runtimes, or security-profile overrides.
 * - Agentbox forces no-new-privileges and upper bounds for memory, CPU, PIDs,
 *   shared memory, container count, exec count, image pulls, request sizes, and
 *   concurrent relayed connections.
 * - Container and exec IDs are tracked in memory. A session cannot inspect or
 *   mutate pre-existing containers, another agentbox session's containers, or
 *   the private relay helper. Client-selected names are aliases only; the host
 *   daemon receives agentbox-owned names.
 * - Network, volume, plugin, secret, service, swarm, build, commit, load/save,
 *   daemon configuration, and other daemon-wide APIs are absent from the
 *   allowlist.
 * - Every workload joins one per-session Docker `Internal` network. It has no
 *   route to the internet, LAN, or another Docker network. External DNS is not
 *   forwarded. This is deliberately separate from SRT's domain allowlist:
 *   workloads receive no external network path at all.
 * - Published TCP ports bind only to 127.0.0.1. Docker implementations differ
 *   in how they publish ports from internal networks, so agentbox owns those
 *   listeners and carries each stream through a capability-free, read-only,
 *   resource-limited helper on the same internal network. Docker inspect/list
 *   responses are rewritten so normal clients still see the mapping. UDP and
 *   SCTP publication is rejected.
 *
 * Deliberate non-goals and remaining authority
 * ---------------------------------------------
 * This is not a hardened replacement for Docker or a defense against a kernel,
 * container-runtime, daemon, or image-parser vulnerability. A workload may run
 * arbitrary code as root inside its own container, attack services in its own
 * session, consume resources up to the enforced limits, and return arbitrary
 * bytes over a localhost connection that the sandbox initiates. Docker's
 * internal-network contract can also permit access to services bound to the
 * bridge gateway; agentbox prevents external routing, not every interaction
 * with the Docker host.
 *
 * Image pulls are an intentional exception to workload network isolation: the
 * trusted daemon contacts the registry named by the agent. Registry-auth
 * headers are not forwarded, but the daemon-side outbound request still occurs.
 * Finally, the supported API is intentionally incomplete. Clients that need a
 * new Docker feature should fail with a policy error until that feature has
 * been reviewed and added explicitly.
 */
import { accessSync, constants } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  createServer as createNetServer,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { type Duplex } from "node:stream";

import {
  AGENTBOX_DOCKER_LABEL,
  DOCKER_API_VERSION,
  DockerPolicyError,
  DockerSessionState,
  canonicalImageReference,
  imageReferenceFromPullUrl,
  sanitizeContainerCreate,
  sanitizeExecCreate,
  sanitizeExecStart,
  validateImageReference,
} from "./docker-policy.js";
import { findExecutable, runChecked } from "./system.js";

const DEFAULT_DOCKER_SOCKET = "/var/run/docker.sock";
const MAX_JSON_BODY = 2 * 1024 * 1024;
const MAX_ARCHIVE_BODY = 64 * 1024 * 1024;
const MAX_BUFFERED_RESPONSE = 4 * 1024 * 1024;
const MAX_CONTAINERS = 64;
const MAX_EXECS = 512;
const MAX_IMAGES = 32;
const MAX_RELAY_CONNECTIONS = 128;
const DEBUG_DOCKER = process.env.AGENTBOX_DOCKER_DEBUG === "1";

// The relay never runs user code and has no route outside the session's
// internal Docker network. Pinning the multi-platform image index makes this
// small piece of the security boundary reproducible on both amd64 and arm64.
const PORT_RELAY_IMAGE =
  "docker.io/library/alpine@sha256:4b7ce07002c69e8f3d704a9c5d6fd3053be500b7f1c69fc0d80990c2ad8dd412";

type BufferedResponse = {
  statusCode: number;
  statusMessage: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

type ProxyOptions = {
  backendSocketPath?: string;
  // Used by tests to stand up a fake daemon without requiring Unix-socket
  // privileges. Production always uses backendSocketPath.
  backendPort?: number;
};

type PublishedTcpPort = {
  containerPort: number;
  key: string;
  hostPort: number;
  server: NetServer;
  sockets: Set<Socket>;
  targetContainerId?: string;
  upstreams: Set<Duplex>;
};

function debugDocker(message: string): void {
  if (DEBUG_DOCKER) console.error(`agentbox[docker]: ${message}`);
}

function unixSocketPath(dockerHost: string): string | undefined {
  try {
    const url = new URL(dockerHost);
    if (url.protocol !== "unix:") return undefined;
    const path = decodeURIComponent(url.pathname);
    return path.startsWith("/") && !path.includes("\0") ? path : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the active local Docker context without exposing its config. */
export function discoverDockerSocket(): string | undefined {
  const configuredHost = process.env.DOCKER_HOST;
  if (configuredHost) return unixSocketPath(configuredHost);

  if (findExecutable("docker")) {
    try {
      const output = runChecked([
        "docker",
        "context",
        "inspect",
        "--format",
        "{{json .Endpoints.docker.Host}}",
      ]).trim();
      const host: unknown = JSON.parse(output);
      if (typeof host === "string") {
        const path = unixSocketPath(host);
        if (path) return path;
      }
    } catch {
      // Fall through to Docker's standard local socket.
    }
  }
  return DEFAULT_DOCKER_SOCKET;
}

function dockerError(
  response: ServerResponse,
  status: number,
  message: string,
) {
  const body = Buffer.from(JSON.stringify({ message: `agentbox: ${message}` }));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": body.length,
  });
  response.end(body);
}

function routeUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://agentbox-docker.invalid");
}

function unversionedPath(pathname: string): string {
  return pathname.replace(/^\/v\d+\.\d+(?=\/)/, "");
}

function filteredRequestHeaders(
  incoming: IncomingHttpHeaders,
  body?: Buffer,
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const name of ["accept", "content-type", "user-agent"]) {
    const value = incoming[name];
    if (value !== undefined) headers[name] = value;
  }
  if (body) headers["content-length"] = body.length;
  return headers;
}

function filteredResponseHeaders(
  incoming: IncomingHttpHeaders,
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (
      value !== undefined &&
      name !== "connection" &&
      name !== "content-length" &&
      name !== "transfer-encoding" &&
      name !== "upgrade"
    ) {
      headers[name] = value;
    }
  }
  return headers;
}

async function readRequestBody(
  request: IncomingMessage,
  maximum: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maximum)
      throw new DockerPolicyError(`request body exceeds ${maximum} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, length);
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new DockerPolicyError("request body is not valid JSON");
  }
}

function encodedJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

function safeIdentifier(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new DockerPolicyError("invalid Docker resource identifier");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(decoded))
    throw new DockerPolicyError("invalid Docker resource identifier");
  return decoded;
}

function requireAllowedQuery(url: URL, allowed: ReadonlySet<string>): void {
  for (const name of url.searchParams.keys()) {
    if (!allowed.has(name))
      throw new DockerPolicyError(`Docker query option ${name} is blocked`);
  }
}

const CONTAINER_QUERY_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  delete: new Set(["force", "link", "v"]),
  json: new Set(["size"]),
  logs: new Set([
    "details",
    "follow",
    "since",
    "stderr",
    "stdout",
    "tail",
    "timestamps",
    "until",
  ]),
  start: new Set(["detachKeys"]),
  stop: new Set(["signal", "t"]),
  restart: new Set(["signal", "t"]),
  kill: new Set(["signal"]),
  wait: new Set(["condition"]),
  archive: new Set(["copyUIDGID", "noOverwriteDirNonDir", "path"]),
  exec: new Set(),
  attach: new Set([
    "detachKeys",
    "logs",
    "stderr",
    "stdin",
    "stdout",
    "stream",
  ]),
  stats: new Set(["one-shot", "stream"]),
  top: new Set(["ps_args"]),
  changes: new Set(),
  export: new Set(),
  pause: new Set(),
  unpause: new Set(),
  resize: new Set(["h", "w"]),
};

function responsePreamble(response: IncomingMessage): string {
  const lines = [
    `HTTP/${response.httpVersion} ${response.statusCode ?? 502} ${response.statusMessage ?? ""}`,
  ];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index];
    const value = response.rawHeaders[index + 1];
    if (!name || value === undefined) continue;
    lines.push(`${name}: ${value}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

export class RestrictedDockerProxy {
  readonly state = new DockerSessionState();
  readonly backendSocketPath: string | undefined;
  private readonly backendPort: number | undefined;
  private backendApiVersion = DOCKER_API_VERSION;
  private server: Server | undefined;
  private readonly clientSockets = new Set<Socket>();
  private networkPromise: Promise<void> | undefined;
  private networkCreated = false;
  private closing = false;
  private containerSequence = 0;
  private relayHelperPromise: Promise<string> | undefined;
  private relayHelperId: string | undefined;
  private readonly publishedPorts = new Map<string, PublishedTcpPort[]>();
  private readonly relaySockets = new Set<Socket>();
  private readonly relayUpstreams = new Set<Duplex>();

  constructor(options: ProxyOptions = {}) {
    this.backendPort = options.backendPort;
    this.backendSocketPath = options.backendPort
      ? options.backendSocketPath
      : (options.backendSocketPath ?? DEFAULT_DOCKER_SOCKET);
  }

  static async startIfAvailable(
    options: ProxyOptions = {},
  ): Promise<RestrictedDockerProxy | undefined> {
    const backendSocketPath =
      options.backendSocketPath ?? discoverDockerSocket();
    if (!backendSocketPath) return undefined;
    const proxy = new RestrictedDockerProxy({
      ...options,
      backendSocketPath,
    });
    try {
      if (!proxy.backendSocketPath) return undefined;
      accessSync(proxy.backendSocketPath, constants.R_OK | constants.W_OK);
      const ping = await proxy.backendBuffered("GET", "/_ping");
      if (ping.statusCode < 200 || ping.statusCode >= 300) return undefined;
      const version = await proxy.backendBuffered("GET", "/version");
      if (version.statusCode >= 200 && version.statusCode < 300) {
        try {
          const body = JSON.parse(version.body.toString("utf8")) as {
            ApiVersion?: unknown;
          };
          if (
            typeof body.ApiVersion === "string" &&
            /^\d+\.\d+$/.test(body.ApiVersion)
          ) {
            proxy.backendApiVersion = `v${body.ApiVersion}`;
          }
        } catch {
          // The ping succeeded, so retain the conservative compatibility
          // version if a Docker-compatible daemon omits version metadata.
        }
      }
      await proxy.start();
      return proxy;
    } catch {
      return undefined;
    }
  }

  private backendConnection():
    { socketPath: string } | { hostname: string; port: number } {
    if (this.backendPort)
      return { hostname: "127.0.0.1", port: this.backendPort };
    if (!this.backendSocketPath)
      throw new Error("Docker backend has no socket path");
    return { socketPath: this.backendSocketPath };
  }

  private apiPath(path: string): string {
    return `/${this.backendApiVersion}${path}`;
  }

  get environment(): Record<string, string> {
    const address = this.server?.address();
    if (!address || typeof address === "string")
      throw new Error("restricted Docker proxy is not listening");
    return {
      DOCKER_HOST: `tcp://127.0.0.1:${(address as AddressInfo).port}`,
      TESTCONTAINERS_HOST_OVERRIDE: "127.0.0.1",
    };
  }

  async start(): Promise<void> {
    if (this.server) throw new Error("restricted Docker proxy already started");
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    server.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head);
    });
    server.on("connection", (socket) => {
      // Docker's hijacked connections are full duplex. A client may half-close
      // stdin while continuing to read stdout, so do not let Node mirror the
      // incoming FIN onto the response side of the TCP connection.
      socket.allowHalfOpen = true;
      this.clientSockets.add(socket);
      socket.once("close", () => this.clientSockets.delete(socket));
    });
    server.on("clientError", (_error, socket) => socket.destroy());

    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolvePromise();
      });
    });
    this.server = server;
  }

  private backendBuffered(
    method: string,
    path: string,
    body?: Buffer,
    headers: IncomingHttpHeaders = {},
  ): Promise<BufferedResponse> {
    return new Promise<BufferedResponse>((resolvePromise, reject) => {
      const upstream = httpRequest(
        {
          ...this.backendConnection(),
          method,
          path,
          headers: filteredRequestHeaders(headers, body),
        },
        (response) => {
          const chunks: Buffer[] = [];
          let length = 0;
          response.on("data", (chunk: Buffer) => {
            length += chunk.length;
            if (length > MAX_BUFFERED_RESPONSE) {
              upstream.destroy(
                new Error("Docker response exceeded buffering limit"),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.once("end", () => {
            resolvePromise({
              statusCode: response.statusCode ?? 502,
              statusMessage: response.statusMessage ?? "",
              headers: response.headers,
              body: Buffer.concat(chunks, length),
            });
          });
          response.once("error", reject);
        },
      );
      upstream.once("error", reject);
      upstream.end(body);
    });
  }

  private async ensureNetwork(): Promise<void> {
    this.networkPromise ??= (async () => {
      const body = encodedJson({
        Name: this.state.networkName,
        Driver: "bridge",
        // Internal networks have no default route and Docker installs firewall
        // rules which drop traffic to or from other networks. We cannot rely
        // on Docker's ordinary `-p` implementation here: although a Linux host
        // can address containers on an internal bridge directly, macOS Docker
        // implementations do not consistently publish those ports back across
        // their VM boundary. Agentbox therefore owns localhost listeners and
        // carries each TCP stream through an exec in an internal-only helper.
        // See ensureRelayHelper() and forwardRelayConnection().
        Internal: true,
        CheckDuplicate: true,
        Labels: { [AGENTBOX_DOCKER_LABEL]: this.state.sessionId },
      });
      const result = await this.backendBuffered(
        "POST",
        this.apiPath("/networks/create"),
        body,
        { "content-type": "application/json" },
      );
      if (result.statusCode < 200 || result.statusCode >= 300) {
        throw new Error(
          `could not create restricted Docker network: ${result.body.toString("utf8")}`,
        );
      }
      this.networkCreated = true;
    })();
    return this.networkPromise;
  }

  private async ensureRelayImage(): Promise<void> {
    const imagePath = encodeURIComponent(PORT_RELAY_IMAGE);
    const inspect = await this.backendBuffered(
      "GET",
      this.apiPath(`/images/${imagePath}/json`),
    );
    if (inspect.statusCode >= 200 && inspect.statusCode < 300) return;

    const pull = await this.backendBuffered(
      "POST",
      this.apiPath(
        `/images/create?fromImage=${encodeURIComponent(PORT_RELAY_IMAGE)}`,
      ),
    );
    if (pull.statusCode < 200 || pull.statusCode >= 300) {
      throw new Error(
        `could not pull the internal Docker relay image: ${pull.body.toString("utf8")}`,
      );
    }
    for (const line of pull.body.toString("utf8").split("\n")) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as {
          error?: unknown;
          errorDetail?: { message?: unknown };
        };
        if (event.error) {
          const detail = event.errorDetail?.message;
          throw new Error(
            `could not pull the internal Docker relay image: ${typeof detail === "string" ? detail : String(event.error)}`,
          );
        }
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
  }

  /**
   * Start the one trusted helper used to bridge localhost TCP listeners into
   * the session network. The helper has no published ports, no capabilities,
   * a read-only root filesystem, and—most importantly—only the same internal
   * network as user containers. It therefore cannot become an egress path.
   *
   * For every accepted host connection, agentbox asks Docker to exec BusyBox
   * `nc` here with a fixed container IP and port. The sandbox cannot address
   * this helper through the restricted API, choose its command, or attach it
   * to another network.
   */
  private ensureRelayHelper(): Promise<string> {
    this.relayHelperPromise ??= (async () => {
      await this.ensureNetwork();
      await this.ensureRelayImage();
      const create = await this.backendBuffered(
        "POST",
        this.apiPath(
          `/containers/create?name=agentbox-${this.state.sessionId.slice(0, 8)}-port-relay`,
        ),
        encodedJson({
          Image: PORT_RELAY_IMAGE,
          User: "65534:65534",
          Cmd: ["sleep", "infinity"],
          Labels: { "dev.agentbox.internal-relay": this.state.sessionId },
          HostConfig: {
            AutoRemove: false,
            CapDrop: ["ALL"],
            Init: true,
            Memory: 64 * 1024 * 1024,
            NanoCpus: 1_000_000_000,
            NetworkMode: this.state.networkName,
            PidsLimit: 256,
            Privileged: false,
            ReadonlyRootfs: true,
            SecurityOpt: ["no-new-privileges"],
            ShmSize: 16 * 1024 * 1024,
          },
        }),
        { "content-type": "application/json" },
      );
      if (create.statusCode < 200 || create.statusCode >= 300) {
        throw new Error(
          `could not create the internal Docker relay: ${create.body.toString("utf8")}`,
        );
      }
      const created = JSON.parse(create.body.toString("utf8")) as {
        Id?: unknown;
      };
      if (typeof created.Id !== "string")
        throw new Error("Docker omitted the internal relay container id");
      this.relayHelperId = created.Id;

      const start = await this.backendBuffered(
        "POST",
        this.apiPath(`/containers/${encodeURIComponent(created.Id)}/start`),
      );
      if (start.statusCode < 200 || start.statusCode >= 300) {
        throw new Error(
          `could not start the internal Docker relay: ${start.body.toString("utf8")}`,
        );
      }
      return created.Id;
    })().catch(async (error) => {
      this.relayHelperPromise = undefined;
      if (this.relayHelperId) {
        try {
          await this.backendBuffered(
            "DELETE",
            this.apiPath(
              `/containers/${encodeURIComponent(this.relayHelperId)}?force=true&v=true`,
            ),
          );
        } catch {
          // Preserve the original startup error.
        }
        this.relayHelperId = undefined;
      }
      throw error;
    });
    return this.relayHelperPromise;
  }

  private requestedPublishedPorts(
    container: Record<string, unknown>,
  ): Array<{ key: string; containerPort: number; hostPort: number }> {
    const host = container.HostConfig as Record<string, unknown>;
    const bindings = (host.PortBindings ?? {}) as Record<
      string,
      Array<{ HostPort: string }>
    >;
    const requested = new Map<string, number>();
    for (const [key, values] of Object.entries(bindings)) {
      const port = Number.parseInt(key.slice(0, key.indexOf("/")), 10);
      requested.set(key, Number.parseInt(values[0]?.HostPort ?? "", 10) || 0);
      if (!Number.isInteger(port))
        throw new DockerPolicyError(`invalid published port ${key}`);
    }

    if (host.PublishAllPorts === true) {
      const exposed = (container.ExposedPorts ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(exposed)) {
        if (!key.endsWith("/tcp") || requested.has(key)) continue;
        requested.set(key, 0);
      }
    }

    // Docker cannot publish a port from an internal network consistently on
    // macOS. Never leave these settings for the daemon to partially honor;
    // the local listeners below are the sole publication mechanism.
    delete host.PortBindings;
    host.PublishAllPorts = false;

    return [...requested].map(([key, hostPort]) => ({
      key,
      containerPort: Number.parseInt(key, 10),
      hostPort,
    }));
  }

  private async reservePublishedPorts(
    requests: Array<{ key: string; containerPort: number; hostPort: number }>,
  ): Promise<PublishedTcpPort[]> {
    const reserved: PublishedTcpPort[] = [];
    try {
      for (const request of requests) {
        let relay: PublishedTcpPort;
        const server = createNetServer(
          { allowHalfOpen: true },
          (socket) => void this.forwardRelayConnection(relay, socket),
        );
        server.on("error", (error) =>
          debugDocker(`localhost port relay failed: ${error.message}`),
        );
        relay = {
          ...request,
          server,
          hostPort: 0,
          sockets: new Set(),
          upstreams: new Set(),
        };
        await new Promise<void>((resolvePromise, reject) => {
          server.once("error", reject);
          server.listen(request.hostPort, "127.0.0.1", () => {
            server.off("error", reject);
            resolvePromise();
          });
        });
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("localhost port relay has no TCP address");
        relay.hostPort = address.port;
        reserved.push(relay);
      }
      return reserved;
    } catch (error) {
      await Promise.all(
        reserved.map((relay) => this.closeNetServer(relay.server)),
      );
      throw error;
    }
  }

  private closeNetServer(server: NetServer): Promise<void> {
    return new Promise((resolvePromise) => {
      if (!server.listening) {
        resolvePromise();
        return;
      }
      server.close(() => resolvePromise());
    });
  }

  private async closePublishedPorts(containerId: string): Promise<void> {
    const relays = this.publishedPorts.get(containerId) ?? [];
    this.publishedPorts.delete(containerId);
    for (const relay of relays) {
      for (const socket of relay.sockets) socket.destroy();
      for (const socket of relay.upstreams) socket.destroy();
    }
    await Promise.all(relays.map((relay) => this.closeNetServer(relay.server)));
  }

  private async relayTargetAddress(containerId: string): Promise<string> {
    const inspect = await this.backendBuffered(
      "GET",
      this.apiPath(`/containers/${encodeURIComponent(containerId)}/json`),
    );
    if (inspect.statusCode < 200 || inspect.statusCode >= 300)
      throw new Error("the target Docker container is unavailable");
    const body = JSON.parse(inspect.body.toString("utf8")) as {
      State?: { Running?: unknown };
      NetworkSettings?: {
        Networks?: Record<string, { IPAddress?: unknown }>;
      };
    };
    if (body.State?.Running !== true)
      throw new Error("the target Docker container is not running");
    const address =
      body.NetworkSettings?.Networks?.[this.state.networkName]?.IPAddress;
    if (
      typeof address !== "string" ||
      !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)
    )
      throw new Error("the target Docker container has no session address");
    return address;
  }

  private backendUpgrade(
    path: string,
    body: Buffer,
  ): Promise<{ socket: Duplex; head: Buffer }> {
    return new Promise((resolvePromise, reject) => {
      const request = httpRequest({
        ...this.backendConnection(),
        method: "POST",
        path,
        headers: {
          "content-type": "application/json",
          "content-length": body.length,
          connection: "Upgrade",
          upgrade: "tcp",
        },
      });
      request.once("upgrade", (_response, socket, head) =>
        resolvePromise({ socket, head }),
      );
      request.once("response", (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          reject(
            new Error(
              `Docker rejected the port relay exec: ${Buffer.concat(chunks).toString("utf8")}`,
            ),
          ),
        );
      });
      request.once("error", reject);
      request.end(body);
    });
  }

  private async openRelayUpstream(
    relay: PublishedTcpPort,
  ): Promise<{ socket: Duplex; head: Buffer }> {
    if (!relay.targetContainerId)
      throw new Error("the target Docker container is not ready");
    const [helperId, targetAddress] = await Promise.all([
      this.ensureRelayHelper(),
      this.relayTargetAddress(relay.targetContainerId),
    ]);
    const create = await this.backendBuffered(
      "POST",
      this.apiPath(`/containers/${encodeURIComponent(helperId)}/exec`),
      encodedJson({
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Cmd: ["nc", "-n", targetAddress, String(relay.containerPort)],
        Privileged: false,
        User: "65534:65534",
      }),
      { "content-type": "application/json" },
    );
    if (create.statusCode < 200 || create.statusCode >= 300)
      throw new Error(
        `could not create a Docker port relay exec: ${create.body.toString("utf8")}`,
      );
    const created = JSON.parse(create.body.toString("utf8")) as {
      Id?: unknown;
    };
    if (typeof created.Id !== "string")
      throw new Error("Docker omitted the port relay exec id");
    return this.backendUpgrade(
      this.apiPath(`/exec/${encodeURIComponent(created.Id)}/start`),
      encodedJson({ Detach: false, Tty: false }),
    );
  }

  private async forwardRelayConnection(
    relay: PublishedTcpPort,
    client: Socket,
  ): Promise<void> {
    if (this.closing || this.relaySockets.size >= MAX_RELAY_CONNECTIONS) {
      client.destroy();
      return;
    }
    client.setNoDelay(true);
    this.relaySockets.add(client);
    relay.sockets.add(client);
    client.once("close", () => {
      this.relaySockets.delete(client);
      relay.sockets.delete(client);
    });

    try {
      const { socket: upstream, head } = await this.openRelayUpstream(relay);
      if (client.destroyed) {
        upstream.destroy();
        return;
      }
      this.relayUpstreams.add(upstream);
      relay.upstreams.add(upstream);
      upstream.once("close", () => {
        this.relayUpstreams.delete(upstream);
        relay.upstreams.delete(upstream);
        if (!upstream.readableEnded && !client.destroyed) client.destroy();
      });

      let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let outputBlocked = false;
      const decode = (chunk: Buffer): void => {
        pending =
          pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
        while (!outputBlocked && pending.length >= 8) {
          const stream = pending[0];
          const length = pending.readUInt32BE(4);
          if (length > MAX_ARCHIVE_BODY) {
            client.destroy(new Error("Docker port relay frame is too large"));
            upstream.destroy();
            return;
          }
          if (pending.length < 8 + length) return;
          const payload = pending.subarray(8, 8 + length);
          pending = pending.subarray(8 + length);
          if (stream === 1 && payload.length > 0) {
            if (!client.write(payload)) {
              outputBlocked = true;
              upstream.pause();
              client.once("drain", () => {
                outputBlocked = false;
                decode(Buffer.alloc(0));
                upstream.resume();
              });
            }
          } else if (stream === 2 && payload.length > 0)
            debugDocker(`port relay: ${payload.toString("utf8").trim()}`);
        }
      };

      if (head.length > 0) decode(head);
      upstream.on("data", decode);
      client.on("data", (chunk) => {
        if (!upstream.write(chunk)) client.pause();
      });
      upstream.on("drain", () => client.resume());
      client.once("end", () => upstream.end());
      client.once("close", () => upstream.destroy());
      upstream.once("end", () => client.end());
      upstream.once("error", () => client.destroy());
    } catch (error) {
      debugDocker(
        `port relay connection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      client.destroy();
    }
  }

  private relayBindings(
    containerId: string,
  ): Record<string, Array<{ HostIp: string; HostPort: string }>> {
    return Object.fromEntries(
      (this.publishedPorts.get(containerId) ?? []).map((relay) => [
        relay.key,
        [{ HostIp: "127.0.0.1", HostPort: String(relay.hostPort) }],
      ]),
    );
  }

  private async forwardContainerInspect(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    containerId: string,
  ): Promise<void> {
    const result = await this.backendBuffered(
      request.method ?? "GET",
      path,
      undefined,
      request.headers,
    );
    if (result.statusCode >= 200 && result.statusCode < 300) {
      const body = JSON.parse(result.body.toString("utf8")) as Record<
        string,
        unknown
      >;
      const bindings = this.relayBindings(containerId);
      const host = (body.HostConfig ?? {}) as Record<string, unknown>;
      host.PortBindings = bindings;
      body.HostConfig = host;
      const network = (body.NetworkSettings ?? {}) as Record<string, unknown>;
      network.Ports = {
        ...((network.Ports ?? {}) as Record<string, unknown>),
        ...bindings,
      };
      body.NetworkSettings = network;
      result.body = encodedJson(body);
      result.headers["content-type"] = "application/json";
    }
    this.writeBufferedResponse(response, result);
  }

  private async forwardContainerList(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    const result = await this.backendBuffered(
      request.method ?? "GET",
      path,
      undefined,
      request.headers,
    );
    if (result.statusCode >= 200 && result.statusCode < 300) {
      const containers = JSON.parse(result.body.toString("utf8")) as Array<
        Record<string, unknown>
      >;
      for (const container of containers) {
        if (typeof container.Id !== "string") continue;
        const published = (this.publishedPorts.get(container.Id) ?? []).map(
          (relay) => ({
            IP: "127.0.0.1",
            PrivatePort: relay.containerPort,
            PublicPort: relay.hostPort,
            Type: "tcp",
          }),
        );
        const publishedKeys = new Set(
          published.map((port) => `${port.PrivatePort}/${port.Type}`),
        );
        const existing = (
          (container.Ports ?? []) as Array<Record<string, unknown>>
        ).filter(
          (port) =>
            !publishedKeys.has(`${String(port.PrivatePort)}/${port.Type}`),
        );
        container.Ports = [...existing, ...published];
      }
      result.body = encodedJson(containers);
      result.headers["content-type"] = "application/json";
    }
    this.writeBufferedResponse(response, result);
  }

  private writeBufferedResponse(
    response: ServerResponse,
    result: BufferedResponse,
  ): void {
    const headers = filteredResponseHeaders(result.headers);
    headers["content-length"] = result.body.length;
    response.writeHead(result.statusCode, result.statusMessage, headers);
    response.end(result.body);
  }

  private async forwardBuffered(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    body?: Buffer,
  ): Promise<BufferedResponse> {
    const result = await this.backendBuffered(
      request.method ?? "GET",
      path,
      body,
      request.headers,
    );
    this.writeBufferedResponse(response, result);
    return result;
  }

  private forwardStream(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    body?: Buffer,
    onComplete?: (successful: boolean) => void,
  ): void {
    const upstream = httpRequest(
      {
        ...this.backendConnection(),
        method: request.method,
        path,
        headers: filteredRequestHeaders(request.headers, body),
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.statusMessage,
          filteredResponseHeaders(upstreamResponse.headers),
        );
        // Preserve streaming endpoint semantics. In particular, the Docker CLI
        // opens `/wait` before starting a container and waits only for the
        // response headers before issuing `/start`. Node otherwise buffers the
        // headers until the first body chunk, creating a lifecycle deadlock.
        response.flushHeaders();
        let reportedError = false;
        let pending = "";
        upstreamResponse.on("data", (chunk: Buffer) => {
          if (onComplete) {
            pending += chunk.toString("utf8");
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines) {
              try {
                const event = JSON.parse(line) as { error?: unknown };
                if (event.error) reportedError = true;
              } catch {
                // Docker progress responses are normally line-delimited JSON.
                // Malformed progress is not itself an authorization concern.
              }
            }
          }
        });
        upstreamResponse.once("end", () => {
          if (onComplete && pending) {
            try {
              const event = JSON.parse(pending) as { error?: unknown };
              if (event.error) reportedError = true;
            } catch {
              // See the comment above.
            }
          }
          onComplete?.(
            !reportedError &&
              (upstreamResponse.statusCode ?? 500) >= 200 &&
              (upstreamResponse.statusCode ?? 500) < 300,
          );
        });
        upstreamResponse.pipe(response);
      },
    );
    upstream.once("error", (error) => {
      if (!response.headersSent)
        dockerError(response, 502, `Docker proxy failed: ${error.message}`);
      else response.destroy(error);
      onComplete?.(false);
    });
    request.once("aborted", () => upstream.destroy());
    upstream.end(body);
  }

  private requireContainer(identifier: string): string {
    const id = this.state.resolveContainer(identifier);
    if (id) return id;
    throw new DockerPolicyError(
      "the requested container was not created by this agentbox session",
    );
  }

  private requireExec(id: string): void {
    if (!this.state.ownsExec(id))
      throw new DockerPolicyError(
        "the requested exec was not created by this agentbox session",
      );
  }

  private containerPath(id: string, operation: string | undefined, url: URL) {
    const suffix = operation ? `/${operation}` : "";
    return this.apiPath(
      `/containers/${encodeURIComponent(id)}${suffix}${url.search}`,
    );
  }

  private sessionContainerListPath(url: URL): string {
    requireAllowedQuery(
      url,
      new Set(["all", "before", "filters", "limit", "since", "size"]),
    );
    let filters: Record<string, unknown> = {};
    const encodedFilters = url.searchParams.get("filters");
    if (encodedFilters) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(encodedFilters);
      } catch {
        throw new DockerPolicyError("invalid container-list filters");
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      )
        throw new DockerPolicyError("invalid container-list filters");
      filters = parsed as Record<string, unknown>;
    }
    const nameFilter = filters.name;
    if (nameFilter !== undefined) {
      const names = Array.isArray(nameFilter)
        ? nameFilter
        : typeof nameFilter === "object" && nameFilter !== null
          ? Object.keys(nameFilter)
          : [];
      const ids = names.flatMap((name) => {
        if (typeof name !== "string") return [];
        const id = this.state.resolveContainer(name.replace(/^\^\/?|\$$/g, ""));
        return id ? [id] : [];
      });
      delete filters.name;
      filters.id = ids.length > 0 ? ids : ["agentbox-no-matching-container"];
    }
    filters.label = [`${AGENTBOX_DOCKER_LABEL}=${this.state.sessionId}`];
    const parameters = new URLSearchParams(url.searchParams);
    parameters.set("filters", JSON.stringify(filters));
    return this.apiPath(`/containers/json?${parameters.toString()}`);
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const url = routeUrl(request);
      const path = unversionedPath(url.pathname);
      const method = request.method ?? "GET";
      debugDocker(`${method} ${path}`);

      if ((method === "GET" || method === "HEAD") && path === "/_ping") {
        this.forwardStream(request, response, request.url ?? "/_ping");
        return;
      }
      if (method === "GET" && path === "/version") {
        this.forwardStream(request, response, request.url ?? "/version");
        return;
      }
      if (method === "GET" && path === "/containers/json") {
        await this.forwardContainerList(
          request,
          response,
          this.sessionContainerListPath(url),
        );
        return;
      }
      if (method === "POST" && path === "/images/create") {
        if (this.state.pulledImages.size >= MAX_IMAGES)
          throw new DockerPolicyError(
            `a session may pull at most ${MAX_IMAGES} images`,
          );
        const image = imageReferenceFromPullUrl(url);
        debugDocker(`allow pull ${JSON.stringify(image)}`);
        this.forwardStream(
          request,
          response,
          request.url ?? url.pathname,
          undefined,
          (successful) => {
            if (successful) this.state.pulledImages.add(image);
          },
        );
        return;
      }
      if (method === "POST" && path === "/containers/create") {
        if (this.state.containers.size >= MAX_CONTAINERS)
          throw new DockerPolicyError(
            `a session may create at most ${MAX_CONTAINERS} containers`,
          );
        const input = parseJson(await readRequestBody(request, MAX_JSON_BODY));
        const requestedImage = validateImageReference(
          typeof input === "object" && input !== null && "Image" in input
            ? String(input.Image)
            : "",
        );
        const image = canonicalImageReference(requestedImage);
        debugDocker(
          `create ${JSON.stringify(image)}; session images ${JSON.stringify([...this.state.pulledImages])}`,
        );
        if (!this.state.pulledImages.has(image)) {
          dockerError(
            response,
            404,
            `image ${image} must be pulled through this session before use`,
          );
          return;
        }
        await this.ensureNetwork();
        const sanitizedCreate = sanitizeContainerCreate(
          input,
          this.state.sessionId,
          this.state.networkName,
        );
        const requestedNameValue = url.searchParams.get("name");
        const requestedName = requestedNameValue
          ? safeIdentifier(requestedNameValue)
          : undefined;
        if (requestedName && this.state.containerAliases.has(requestedName)) {
          throw new DockerPolicyError(
            `container name ${requestedName} is already in use in this session`,
          );
        }
        if (requestedName) {
          sanitizedCreate.NetworkingConfig = {
            EndpointsConfig: {
              [this.state.networkName]: { Aliases: [requestedName] },
            },
          };
        }
        const publishedRequests = this.requestedPublishedPorts(sanitizedCreate);
        const reservedPorts =
          await this.reservePublishedPorts(publishedRequests);
        const body = encodedJson(sanitizedCreate);
        this.containerSequence += 1;
        const upstreamPath = this.apiPath(
          `/containers/create?name=agentbox-${this.state.sessionId.slice(0, 8)}-${this.containerSequence}`,
        );
        let result: BufferedResponse;
        try {
          result = await this.backendBuffered(
            "POST",
            upstreamPath,
            body,
            request.headers,
          );
        } catch (error) {
          await Promise.all(
            reservedPorts.map((relay) => this.closeNetServer(relay.server)),
          );
          throw error;
        }
        if (result.statusCode >= 200 && result.statusCode < 300) {
          const parsed = JSON.parse(result.body.toString("utf8")) as {
            Id?: unknown;
          };
          if (typeof parsed.Id !== "string") {
            await Promise.all(
              reservedPorts.map((relay) => this.closeNetServer(relay.server)),
            );
            throw new Error("Docker omitted the created container id");
          }
          for (const relay of reservedPorts)
            relay.targetContainerId = parsed.Id;
          if (reservedPorts.length > 0) {
            try {
              await this.ensureRelayHelper();
            } catch (error) {
              await Promise.all(
                reservedPorts.map((relay) => this.closeNetServer(relay.server)),
              );
              await this.backendBuffered(
                "DELETE",
                this.apiPath(
                  `/containers/${encodeURIComponent(parsed.Id)}?force=true&v=true`,
                ),
              );
              throw error;
            }
            this.publishedPorts.set(parsed.Id, reservedPorts);
          }
          this.state.addContainer(parsed.Id, requestedName);
        } else {
          await Promise.all(
            reservedPorts.map((relay) => this.closeNetServer(relay.server)),
          );
        }
        this.writeBufferedResponse(response, result);
        return;
      }

      const containerMatch = path.match(
        /^\/containers\/([^/]+)(?:\/(json|logs|start|stop|restart|kill|wait|archive|exec|attach|stats|top|changes|export|pause|unpause|resize))?$/,
      );
      if (containerMatch) {
        const identifier = safeIdentifier(containerMatch[1] ?? "");
        const id = this.requireContainer(identifier);
        const operation = containerMatch[2];
        const queryPolicy =
          operation === undefined && method === "DELETE"
            ? CONTAINER_QUERY_OPTIONS.delete
            : operation
              ? CONTAINER_QUERY_OPTIONS[operation]
              : undefined;
        if (!queryPolicy)
          throw new DockerPolicyError("this container operation is blocked");
        requireAllowedQuery(url, queryPolicy);
        const upstreamPath = this.containerPath(id, operation, url);

        if (method === "DELETE" && operation === undefined) {
          const result = await this.forwardBuffered(
            request,
            response,
            upstreamPath,
          );
          if (result.statusCode >= 200 && result.statusCode < 300) {
            await this.closePublishedPorts(id);
            this.state.removeContainer(id);
          }
          return;
        }
        if (method === "GET" && operation === "json") {
          await this.forwardContainerInspect(
            request,
            response,
            upstreamPath,
            id,
          );
          return;
        }
        if (
          method === "GET" &&
          (operation === "logs" ||
            operation === "stats" ||
            operation === "top" ||
            operation === "changes" ||
            operation === "export" ||
            operation === "archive")
        ) {
          this.forwardStream(request, response, upstreamPath);
          return;
        }
        if (method === "HEAD" && operation === "archive") {
          this.forwardStream(request, response, upstreamPath);
          return;
        }
        if (
          method === "POST" &&
          (operation === "start" ||
            operation === "stop" ||
            operation === "restart" ||
            operation === "kill" ||
            operation === "wait" ||
            operation === "pause" ||
            operation === "unpause" ||
            operation === "resize")
        ) {
          this.forwardStream(request, response, upstreamPath);
          return;
        }
        if (method === "POST" && operation === "attach") {
          this.forwardStream(request, response, upstreamPath);
          return;
        }
        if (method === "PUT" && operation === "archive") {
          const body = await readRequestBody(request, MAX_ARCHIVE_BODY);
          this.forwardStream(request, response, upstreamPath, body);
          return;
        }
        if (method === "POST" && operation === "exec") {
          if (this.state.execs.size >= MAX_EXECS)
            throw new DockerPolicyError(
              `a session may create at most ${MAX_EXECS} execs`,
            );
          const body = encodedJson(
            sanitizeExecCreate(
              parseJson(await readRequestBody(request, MAX_JSON_BODY)),
            ),
          );
          const result = await this.forwardBuffered(
            request,
            response,
            upstreamPath,
            body,
          );
          if (result.statusCode >= 200 && result.statusCode < 300) {
            const parsed = JSON.parse(result.body.toString("utf8")) as {
              Id?: unknown;
            };
            if (typeof parsed.Id === "string") this.state.execs.add(parsed.Id);
          }
          return;
        }
      }

      const execMatch = path.match(/^\/exec\/([^/]+)\/(json|start)$/);
      if (execMatch) {
        const id = safeIdentifier(execMatch[1] ?? "");
        const operation = execMatch[2];
        requireAllowedQuery(url, new Set());
        this.requireExec(id);
        if (method === "GET" && operation === "json") {
          this.forwardStream(
            request,
            response,
            this.apiPath(`/exec/${encodeURIComponent(id)}/json${url.search}`),
          );
          return;
        }
        if (method === "POST" && operation === "start") {
          const body = encodedJson(
            sanitizeExecStart(
              parseJson(await readRequestBody(request, MAX_JSON_BODY)),
            ),
          );
          this.forwardStream(
            request,
            response,
            this.apiPath(`/exec/${encodeURIComponent(id)}/start${url.search}`),
            body,
          );
          return;
        }
      }

      dockerError(
        response,
        403,
        `Docker API operation ${method} ${path} is blocked`,
      );
    } catch (error) {
      if (error instanceof DockerPolicyError) {
        dockerError(response, 403, error.message);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        dockerError(response, 502, `Docker proxy failed: ${message}`);
      }
    }
  }

  private async handleUpgrade(
    request: IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
  ): Promise<void> {
    try {
      const url = routeUrl(request);
      const path = unversionedPath(url.pathname);
      debugDocker(`UPGRADE ${path}`);
      if (request.method !== "POST")
        throw new DockerPolicyError(
          "this upgraded Docker operation is blocked",
        );
      const execMatch = path.match(/^\/exec\/([^/]+)\/start$/);
      const attachMatch = path.match(/^\/containers\/([^/]+)\/attach$/);
      let upstreamBody: Buffer;
      let upstreamPath: string;
      let pendingClientData: Buffer;
      clientSocket.pause();
      if (execMatch) {
        const id = safeIdentifier(execMatch[1] ?? "");
        this.requireExec(id);
        requireAllowedQuery(url, new Set());
        const length = Number(request.headers["content-length"] ?? 0);
        if (
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > MAX_JSON_BODY
        )
          throw new DockerPolicyError("invalid upgraded request body length");
        const split = await this.readUpgradeBody(clientSocket, head, length);
        upstreamBody = encodedJson(sanitizeExecStart(parseJson(split.body)));
        pendingClientData = split.remainder;
        upstreamPath = this.apiPath(
          `/exec/${encodeURIComponent(id)}/start${url.search}`,
        );
      } else if (attachMatch) {
        const identifier = safeIdentifier(attachMatch[1] ?? "");
        const id = this.requireContainer(identifier);
        requireAllowedQuery(url, CONTAINER_QUERY_OPTIONS.attach ?? new Set());
        upstreamBody = Buffer.alloc(0);
        pendingClientData = head;
        upstreamPath = this.containerPath(id, "attach", url);
      } else {
        throw new DockerPolicyError(
          "this upgraded Docker operation is blocked",
        );
      }

      const upstream = httpRequest({
        ...this.backendConnection(),
        method: "POST",
        path: upstreamPath,
        headers: {
          ...filteredRequestHeaders(request.headers, upstreamBody),
          connection: "Upgrade",
          upgrade: request.headers.upgrade ?? "tcp",
        },
      });
      upstream.once("upgrade", (response, upstreamSocket, upstreamHead) => {
        debugDocker(`upstream upgrade ${path}: ${response.statusCode ?? 0}`);
        clientSocket.write(responsePreamble(response));
        if (upstreamHead.length) clientSocket.write(upstreamHead);
        if (pendingClientData.length) upstreamSocket.write(pendingClientData);
        upstreamSocket.once("close", () =>
          debugDocker(`upstream socket closed ${path}`),
        );
        clientSocket.once("close", () =>
          debugDocker(`client socket closed ${path}`),
        );
        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
      });
      upstream.once("response", (response) => {
        debugDocker(
          `upstream non-upgrade ${path}: ${response.statusCode ?? 0}`,
        );
        clientSocket.write(responsePreamble(response));
        response.pipe(clientSocket);
      });
      upstream.once("error", () => clientSocket.destroy());
      upstream.end(upstreamBody);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Docker upgrade was denied";
      const body = Buffer.from(
        JSON.stringify({ message: `agentbox: ${message}` }),
      );
      clientSocket.end(
        `HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body.toString("utf8")}`,
      );
    }
  }

  private readUpgradeBody(
    socket: Duplex,
    head: Buffer,
    length: number,
  ): Promise<{ body: Buffer; remainder: Buffer }> {
    if (head.length >= length)
      return Promise.resolve({
        body: head.subarray(0, length),
        remainder: head.subarray(length),
      });
    return new Promise<{ body: Buffer; remainder: Buffer }>(
      (resolvePromise, reject) => {
        const chunks = [head];
        let received = head.length;
        const onData = (chunk: Buffer) => {
          received += chunk.length;
          chunks.push(chunk);
          if (received >= length) {
            socket.pause();
            cleanup();
            const complete = Buffer.concat(chunks, received);
            resolvePromise({
              body: complete.subarray(0, length),
              remainder: complete.subarray(length),
            });
          }
        };
        const onClose = () => {
          cleanup();
          reject(
            new Error("Docker upgrade closed before its body was complete"),
          );
        };
        const cleanup = () => {
          socket.off("data", onData);
          socket.off("close", onClose);
        };
        socket.on("data", onData);
        socket.once("close", onClose);
        socket.resume();
      },
    );
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;

    const server = this.server;
    this.server = undefined;

    for (const socket of this.relaySockets) socket.destroy();
    this.relaySockets.clear();
    for (const socket of this.relayUpstreams) socket.destroy();
    this.relayUpstreams.clear();
    const portServers = [...this.publishedPorts.values()].flatMap((relays) =>
      relays.map((relay) => relay.server),
    );
    this.publishedPorts.clear();
    await Promise.all(portServers.map((relay) => this.closeNetServer(relay)));

    // Remove containers before closing client connections. A Docker client may
    // have a long-lived `/wait`, logs, attach, or stats request in flight; the
    // removal completes those streams naturally and avoids deadlocking proxy
    // shutdown while waiting for the client to disconnect.
    for (const id of this.state.containers) {
      try {
        await this.backendBuffered(
          "DELETE",
          this.apiPath(
            `/containers/${encodeURIComponent(id)}?force=true&v=true`,
          ),
        );
      } catch {
        // Best-effort cleanup; the session label makes leftovers recognizable.
      }
    }
    this.state.containers.clear();

    if (this.relayHelperId) {
      try {
        await this.backendBuffered(
          "DELETE",
          this.apiPath(
            `/containers/${encodeURIComponent(this.relayHelperId)}?force=true&v=true`,
          ),
        );
      } catch {
        // Best-effort cleanup; this container carries no host resources.
      }
      this.relayHelperId = undefined;
    }

    if (this.networkCreated) {
      try {
        await this.backendBuffered(
          "DELETE",
          this.apiPath(
            `/networks/${encodeURIComponent(this.state.networkName)}`,
          ),
        );
      } catch {
        // Best-effort cleanup; Docker may still be removing a container.
      }
    }

    if (server) {
      const closed = new Promise<void>((resolvePromise) =>
        server.close(() => resolvePromise()),
      );
      for (const socket of this.clientSockets) socket.destroy();
      this.clientSockets.clear();
      await closed;
    }
  }
}
