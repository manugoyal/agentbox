#!/usr/bin/env node

/**
 * Docker compatibility without exposing the host Docker daemon.
 *
 * Access to a host Docker socket is effectively host-level access, so filtering
 * individual Docker API calls is not a useful security boundary. Agentbox
 * instead runs an unrestricted Docker daemon in a dedicated Lima VM created
 * without host mounts. A credential-free supervisor keeps Lima's host-side
 * processes inside their own long-lived SRT sandbox and exposes the guest daemon
 * to Agentbox commands through a loopback TCP bridge. The host Docker socket,
 * Lima state, and VM control sockets remain unavailable to the coding agent.
 *
 * The VM, not the Docker API, is the isolation boundary. Code may become root in
 * the guest, mount the guest filesystem, reconfigure Docker, use external
 * networking, and publish ports back to the host. The backend is also shared by
 * every Agentbox launch: this preserves images and build caches, but provides no
 * isolation between sessions. It must not be used as a secret store and is
 * designed to be disposable through `agentbox --docker-reset`.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  createConnection,
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
import { fileURLToPath } from "node:url";

import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import { z } from "zod";

import { runChild } from "./child-process.js";
import { AgentboxError } from "./errors.js";
import { EMBEDDED_POLICY } from "./policy.js";
import { findExecutable, replaceProcessEnvironment } from "./system.js";

const STATE_VERSION = 1;
const INSTANCE_NAME = "agentbox-docker";
const START_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 250;

const backendStateSchema = z.object({
  version: z.literal(STATE_VERSION),
  pid: z.number().int().positive(),
  status: z.enum(["starting", "ready", "failed", "stopped"]),
  port: z.number().int().min(1).max(65535).optional(),
  startedAt: z.string(),
  message: z.string().optional(),
});

export type LimaBackendState = z.infer<typeof backendStateSchema>;

export type LimaBackendLayout = {
  root: string;
  hostHome: string;
  limaHome: string;
  temp: string;
  state: string;
  lock: string;
  log: string;
  dockerSocket: string;
};

export type LimaBackendStatus = {
  installed: boolean;
  running: boolean;
  state?: LimaBackendState;
  log: string;
};

export function limaBackendLayout(
  root = process.env.AGENTBOX_LIMA_BACKEND_ROOT ??
    join(homedir(), ".agentbox", "docker"),
): LimaBackendLayout {
  const absoluteRoot = resolve(root);
  const limaHome = join(absoluteRoot, "lima");
  return {
    root: absoluteRoot,
    hostHome: join(absoluteRoot, "home"),
    limaHome,
    temp: join(absoluteRoot, "tmp"),
    state: join(absoluteRoot, "state.json"),
    lock: join(absoluteRoot, "launch.lock"),
    log: join(absoluteRoot, "supervisor.log"),
    dockerSocket: join(limaHome, INSTANCE_NAME, "sock", "docker.sock"),
  };
}

function prepareLayout(layout: LimaBackendLayout): void {
  for (const path of [
    layout.root,
    layout.hostHome,
    layout.limaHome,
    layout.temp,
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
}

function readState(layout: LimaBackendLayout): LimaBackendState | undefined {
  try {
    return backendStateSchema.parse(
      JSON.parse(readFileSync(layout.state, "utf8")),
    );
  } catch {
    return undefined;
  }
}

function writeState(layout: LimaBackendLayout, state: LimaBackendState): void {
  const temporary = `${layout.state}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, layout.state);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

function dockerPing(
  endpoint: { socketPath: string } | { port: number },
): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    const request = httpRequest(
      "socketPath" in endpoint
        ? { socketPath: endpoint.socketPath, path: "/_ping", method: "GET" }
        : {
            hostname: "127.0.0.1",
            port: endpoint.port,
            path: "/_ping",
            method: "GET",
          },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          const body = Buffer.concat(chunks).toString("utf8").trim();
          resolvePromise(
            response.statusCode === 200 && body.toUpperCase() === "OK",
          );
        });
      },
    );
    request.setTimeout(1_000, () => request.destroy());
    request.once("error", () => resolvePromise(false));
    request.end();
  });
}

/** A transparent TCP-to-Unix bridge; it does not parse or filter Docker. */
export class LimaDockerRelay {
  readonly socketPath: string;
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async start(): Promise<number> {
    if (this.server) throw new Error("Lima Docker relay is already running");
    const server = createServer({ allowHalfOpen: true }, (client) => {
      client.setNoDelay(true);
      const upstream = createConnection({ path: this.socketPath });
      upstream.setNoDelay(true);
      this.sockets.add(client);
      this.sockets.add(upstream);
      const forget = (socket: Socket) => this.sockets.delete(socket);
      client.once("close", () => forget(client));
      upstream.once("close", () => forget(upstream));
      client.once("error", () => upstream.destroy());
      upstream.once("error", () => client.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
    });
    server.on("connection", (socket) =>
      socket.once("error", () => socket.destroy()),
    );
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolvePromise();
      });
    });
    this.server = server;
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Lima Docker relay has no TCP address");
    return (address as AddressInfo).port;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (!server?.listening) return;
    await new Promise<void>((resolvePromise) =>
      server.close(() => resolvePromise()),
    );
  }
}

function supervisorPolicy(
  layout: LimaBackendLayout,
  runtimeDirectory: string,
): SandboxRuntimeConfig {
  const nodeRuntime = resolve(dirname(realpathSync(process.execPath)), "..");
  const virtualizationDevices = ["/dev/kvm", "/dev/vhost-net"].filter(
    existsSync,
  );
  return {
    filesystem: {
      denyRead: [homedir()],
      allowRead: [layout.root, runtimeDirectory, nodeRuntime],
      allowWrite: [
        "/dev/stdout",
        "/dev/stderr",
        "/dev/null",
        "/dev/dtracehelper",
        "/dev/autofs_nowait",
        ...virtualizationDevices,
        layout.root,
        "/private/var/folders",
      ],
      denyWrite: [runtimeDirectory],
    },
    network: {
      ...structuredClone(EMBEDDED_POLICY.network),
      // Lima's hostagent, port forwarding, and VM drivers use private control
      // sockets. Keep those sockets inside the otherwise hidden backend root.
      allowUnixSockets: [layout.root],
      // SRT can filter Unix sockets by path on macOS. Linux seccomp cannot, so
      // its credential-free Lima supervisor needs the broader socket switch;
      // filesystem access and the guest boundary remain independently scoped.
      allowAllUnixSockets: process.platform === "linux",
    },
    ignoreViolations: {},
    allowPty: false,
    enableWeakerNestedSandbox: true,
  };
}

function supervisorEnvironment(layout: LimaBackendLayout): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: layout.hostHome,
    LIMA_HOME: layout.limaHome,
    PATH: process.env.PATH ?? "",
    SHELL: process.env.SHELL ?? "/bin/sh",
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    LC_ALL: process.env.LC_ALL,
    LC_CTYPE: process.env.LC_CTYPE,
    TMPDIR: layout.temp,
    CLAUDE_CODE_TMPDIR: layout.temp,
  };
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] =>
      Boolean(entry[1]),
    ),
  );
}

export function limaStartCommand(
  limactl: string,
  layout: LimaBackendLayout,
): string[] {
  const existing = existsSync(
    join(layout.limaHome, INSTANCE_NAME, "lima.yaml"),
  );
  if (existing)
    return [limactl, "start", "--foreground", "--tty=false", INSTANCE_NAME];
  return [
    limactl,
    "start",
    "--foreground",
    "--tty=false",
    "--name",
    INSTANCE_NAME,
    "--mount-none",
    "template:docker",
  ];
}

async function startSandboxedLima(
  command: readonly string[],
  layout: LimaBackendLayout,
): Promise<{ completion: Promise<number> }> {
  const runtimeDirectory = dirname(fileURLToPath(import.meta.url));
  const environment = supervisorEnvironment(layout);
  environment.AGENTBOX_INTERNAL_COMMAND = Buffer.from(
    JSON.stringify(command),
  ).toString("base64url");
  environment.AGENTBOX_INTERNAL_NODE = process.execPath;
  environment.AGENTBOX_INTERNAL_RUNNER = join(
    runtimeDirectory,
    "child-runner.js",
  );

  await SandboxManager.initialize(supervisorPolicy(layout, runtimeDirectory));
  replaceProcessEnvironment(environment);
  let wrapped = await SandboxManager.wrapWithSandbox(
    'exec "$AGENTBOX_INTERNAL_NODE" "$AGENTBOX_INTERNAL_RUNNER"',
    "/bin/bash",
  );

  if (process.platform === "darwin") {
    wrapped = allowMacOSVirtualization(wrapped);
  }

  return {
    completion: runChild("/bin/bash", ["-c", wrapped], {
      cwd: layout.root,
      env: process.env,
      stdio: "inherit",
    }),
  };
}

/**
 * Add Apple's entitlement-gated Virtualization.framework permissions to the
 * Seatbelt profile generated by SRT.
 *
 * SRT deliberately emits a small standalone profile instead of importing
 * macOS's broad application-sandbox profiles. Normally that is exactly what
 * agentbox wants. Virtualization.framework is a special case: it checks the
 * read-only `kern.hv_support` capability and runs each VM in the framework's
 * bundled `com.apple.Virtualization.VirtualMachine` XPC service. SRT cannot
 * infer either dependency, so its default-deny profile blocks both. VZ then
 * reports the misleading error that virtualization is unavailable on the
 * hardware.
 *
 * These rules do not make arbitrary agent processes virtualizers. They are
 * applied only to the credential-free Lima supervisor, and `limactl` still
 * needs Apple's `com.apple.security.virtualization` code-signing entitlement.
 */
export function allowMacOSVirtualization(wrapped: string): string {
  const insertionPoint = "; Essential permissions";
  const index = wrapped.indexOf(insertionPoint);
  if (index === -1) {
    throw new AgentboxError(
      "the installed SRT version produced an unrecognized macOS sandbox profile",
    );
  }

  const rules = [
    "; Virtualization.framework capability and VM service",
    '(allow sysctl-read (sysctl-name "kern.hv_support"))',
    "(allow mach-lookup",
    '  (xpc-service-name "com.apple.Virtualization.VirtualMachine"))',
    "",
  ].join("\n");
  // SRT single-quotes the complete Seatbelt profile in its shell wrapper.
  // Keep inserted profile text apostrophe-free so it stays within that arg.
  if (rules.includes("'")) {
    throw new AgentboxError("internal macOS sandbox profile quoting error");
  }
  return `${wrapped.slice(0, index)}${rules}${wrapped.slice(index)}`;
}

async function waitForDockerSocket(
  layout: LimaBackendLayout,
  limaCompletion: Promise<number>,
): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let exited: number | undefined;
  let failure: unknown;
  void limaCompletion.then(
    (code) => {
      exited = code;
    },
    (error: unknown) => {
      failure = error;
    },
  );
  while (Date.now() < deadline) {
    if (failure !== undefined) throw failure;
    if (exited !== undefined)
      throw new Error(
        `Lima exited with status ${exited} before Docker started`,
      );
    if (await dockerPing({ socketPath: layout.dockerSocket })) return;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error("timed out waiting for the Lima Docker socket");
}

async function runSupervisor(layout: LimaBackendLayout): Promise<number> {
  prepareLayout(layout);
  const limactl = findExecutable("limactl");
  if (!limactl) throw new Error("limactl is not installed");
  const startedAt = new Date().toISOString();
  writeState(layout, {
    version: STATE_VERSION,
    pid: process.pid,
    status: "starting",
    startedAt,
  });

  let relay: LimaDockerRelay | undefined;
  try {
    const { completion } = await startSandboxedLima(
      limaStartCommand(limactl, layout),
      layout,
    );
    await waitForDockerSocket(layout, completion);
    relay = new LimaDockerRelay(layout.dockerSocket);
    const port = await relay.start();
    writeState(layout, {
      version: STATE_VERSION,
      pid: process.pid,
      status: "ready",
      port,
      startedAt,
    });
    const exitCode = await completion;
    writeState(layout, {
      version: STATE_VERSION,
      pid: process.pid,
      status: "stopped",
      startedAt,
      message: `Lima exited with status ${exitCode}`,
    });
    return exitCode;
  } catch (error) {
    // A failed readiness check (including timeout or spawn failure) must not
    // leave an orphaned VM whose host-side processes outlive the SRT proxy.
    spawnSync(limactl, ["stop", "--force", INSTANCE_NAME], {
      env: limaHostEnvironment(layout),
      stdio: "ignore",
    });
    writeState(layout, {
      version: STATE_VERSION,
      pid: process.pid,
      status: "failed",
      startedAt,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await relay?.close();
    SandboxManager.cleanupAfterCommand();
    await SandboxManager.reset();
  }
}

function acquireLaunchLock(layout: LimaBackendLayout): boolean {
  try {
    writeFileSync(layout.lock, `${process.pid}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner = 0;
    try {
      owner = Number.parseInt(readFileSync(layout.lock, "utf8"), 10);
    } catch {
      // Treat an unreadable lock as stale.
    }
    if (Number.isInteger(owner) && owner > 0 && processIsAlive(owner))
      return false;
    try {
      unlinkSync(layout.lock);
    } catch {
      return false;
    }
    return acquireLaunchLock(layout);
  }
}

function spawnSupervisor(layout: LimaBackendLayout): void {
  prepareLayout(layout);
  if (!acquireLaunchLock(layout)) return;
  try {
    const current = readState(layout);
    if (current && processIsAlive(current.pid)) return;
    if (existsSync(join(layout.limaHome, INSTANCE_NAME, "lima.yaml"))) {
      const limactl = findExecutable("limactl");
      if (limactl) {
        // A dead supervisor may have left Lima's background state behind.
        // Stop it before re-launching under the new foreground sandbox.
        spawnSync(limactl, ["stop", "--force", INSTANCE_NAME], {
          env: limaHostEnvironment(layout),
          stdio: "ignore",
        });
      }
    }
    const log = openSync(layout.log, "a", 0o600);
    try {
      const child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), "--supervise"],
        {
          detached: true,
          env: {
            HOME: homedir(),
            PATH: process.env.PATH ?? "",
            SHELL: process.env.SHELL ?? "/bin/sh",
            USER: process.env.USER,
            LOGNAME: process.env.LOGNAME,
            LANG: process.env.LANG,
            AGENTBOX_LIMA_BACKEND_ROOT: layout.root,
          },
          stdio: ["ignore", log, log],
        },
      );
      if (!child.pid) throw new Error("could not start the Lima supervisor");
      writeState(layout, {
        version: STATE_VERSION,
        pid: child.pid,
        status: "starting",
        startedAt: new Date().toISOString(),
      });
      child.unref();
    } finally {
      closeSync(log);
    }
  } finally {
    try {
      unlinkSync(layout.lock);
    } catch {
      // A concurrent waiter only needs the state file.
    }
  }
}

async function readyState(
  layout: LimaBackendLayout,
): Promise<LimaBackendState | undefined> {
  const state = readState(layout);
  if (
    state?.status !== "ready" ||
    state.port === undefined ||
    !processIsAlive(state.pid)
  ) {
    return undefined;
  }
  return (await dockerPing({ port: state.port })) ? state : undefined;
}

async function waitForReady(
  layout: LimaBackendLayout,
): Promise<LimaBackendState> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ready = await readyState(layout);
    if (ready) return ready;
    const state = readState(layout);
    if (state?.status === "failed" || state?.status === "stopped") {
      throw new AgentboxError(
        `Docker backend ${state.status}: ${state.message ?? `see ${layout.log}`}`,
      );
    }
    if (state && !processIsAlive(state.pid)) {
      throw new AgentboxError(
        `Docker backend supervisor exited; see ${layout.log}`,
      );
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new AgentboxError(
    `timed out starting the Docker backend; see ${layout.log}`,
  );
}

export async function ensureLimaDockerBackend(): Promise<
  Record<string, string> | undefined
> {
  if (!findExecutable("limactl")) return undefined;
  const layout = limaBackendLayout();
  let state = await readyState(layout);
  if (!state) {
    console.error(
      `agentbox: starting shared Lima Docker backend (log: ${layout.log})`,
    );
    spawnSupervisor(layout);
    state = await waitForReady(layout);
  }
  if (state.port === undefined)
    throw new AgentboxError("Docker backend omitted its endpoint");
  return {
    DOCKER_HOST: `tcp://127.0.0.1:${state.port}`,
  };
}

export async function limaBackendStatus(): Promise<LimaBackendStatus> {
  const layout = limaBackendLayout();
  const state = readState(layout);
  const running = Boolean(await readyState(layout));
  return {
    installed: Boolean(findExecutable("limactl")),
    running,
    state,
    log: layout.log,
  };
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await delay(POLL_INTERVAL_MS);
  }
  return !processIsAlive(pid);
}

function limaHostEnvironment(layout: LimaBackendLayout): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: layout.hostHome,
    LIMA_HOME: layout.limaHome,
  };
}

export async function stopLimaDockerBackend(): Promise<boolean> {
  const layout = limaBackendLayout();
  const state = readState(layout);
  const supervisorRunning = Boolean(state && processIsAlive(state.pid));
  if (state && supervisorRunning) {
    process.kill(state.pid, "SIGTERM");
    if (!(await waitForExit(state.pid, 10_000))) {
      if (processIsAlive(state.pid)) process.kill(state.pid, "SIGKILL");
    }
  }

  // Recover from a killed supervisor or a corrupt/missing state file too.
  // `limactl stop` is management-only and runs with the backend's fake HOME.
  const instanceExists = existsSync(
    join(layout.limaHome, INSTANCE_NAME, "lima.yaml"),
  );
  let instanceStopped = false;
  const limactl = findExecutable("limactl");
  if (limactl && instanceExists) {
    const result = spawnSync(limactl, ["stop", "--force", INSTANCE_NAME], {
      env: limaHostEnvironment(layout),
      stdio: "ignore",
    });
    instanceStopped = result.status === 0;
  }

  if (state) {
    writeState(layout, {
      ...state,
      status: "stopped",
      port: undefined,
      message: "stopped by user",
    });
  }
  return supervisorRunning || instanceStopped;
}

export async function resetLimaDockerBackend(): Promise<void> {
  const layout = limaBackendLayout();
  await stopLimaDockerBackend();
  const limactl = findExecutable("limactl");
  if (limactl && existsSync(join(layout.limaHome, INSTANCE_NAME))) {
    const result = spawnSync(limactl, ["delete", "--force", INSTANCE_NAME], {
      env: limaHostEnvironment(layout),
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new AgentboxError(
        (
          result.stderr ||
          result.stdout ||
          "could not delete Lima backend"
        ).trim(),
      );
    }
  }
  // This exact root is dedicated to the disposable backend. Configuration,
  // logs, images, containers, and volumes are all intentionally reset.
  rmSync(layout.root, { recursive: true, force: true });
}

let isMain = false;
if (process.argv[1] !== undefined) {
  try {
    isMain =
      resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
  } catch {
    isMain = false;
  }
}

if (isMain && process.argv[2] === "--supervise") {
  const layout = limaBackendLayout();
  runSupervisor(layout).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      console.error(
        `agentbox: Lima supervisor failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      process.exitCode = 1;
    },
  );
}
