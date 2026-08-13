import { randomUUID } from "node:crypto";

import { z } from "zod";

export const DOCKER_API_VERSION = "v1.47";
export const AGENTBOX_DOCKER_LABEL = "dev.agentbox.session";

const MAX_STRING = 64 * 1024;
const MAX_ITEMS = 4_096;
const MAX_MEMORY_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_NANO_CPUS = 4_000_000_000;
const MAX_PIDS = 1_024;
const MAX_SHM_BYTES = 512 * 1024 * 1024;

const boundedString = z.string().max(MAX_STRING);
const stringList = z.array(boundedString).max(MAX_ITEMS);
const stringMap = z.record(z.string().max(512), boundedString);
const emptyObject = z.object({}).strict();
const exposedPortName = z
  .string()
  .regex(
    /^(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])\/(?:tcp|udp|sctp)$/,
  );
const publishedPortName = z
  .string()
  .regex(
    /^(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])\/tcp$/,
    "agentbox currently supports publishing TCP ports only",
  );

const exposedPortsSchema = z
  .record(exposedPortName, emptyObject)
  .refine((value) => Object.keys(value).length <= 128, {
    message: "at most 128 container ports may be exposed",
  });
const portBindingSchema = z
  .object({
    HostIp: z.string().max(64).optional(),
    HostPort: z
      .string()
      .regex(
        /^(?:|[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/,
      )
      .optional(),
  })
  .strict();
const portBindingsSchema = z
  .record(publishedPortName, z.array(portBindingSchema).max(16).nullable())
  .refine((value) => Object.keys(value).length <= 128, {
    message: "at most 128 container ports may be published",
  });

const healthcheckSchema = z
  .object({
    Test: stringList.optional(),
    Interval: z.number().int().nonnegative().optional(),
    Timeout: z.number().int().nonnegative().optional(),
    Retries: z.number().int().nonnegative().max(1_000).optional(),
    StartPeriod: z.number().int().nonnegative().optional(),
    StartInterval: z.number().int().nonnegative().optional(),
  })
  .strict();

// This schema intentionally describes what a sandbox may request, not the full
// Docker HostConfig. Unknown fields fail closed. In particular, there is no way
// to request mounts, existing volumes, host namespaces, devices, added
// capabilities, a custom runtime, security-profile changes, or privilege.
const requestedHostConfigSchema = z
  .object({
    AutoRemove: z.boolean().optional(),
    CapDrop: stringList.optional(),
    Init: z.boolean().optional(),
    Memory: z.number().int().nonnegative().optional(),
    NanoCpus: z.number().int().nonnegative().optional(),
    PidsLimit: z.number().int().nonnegative().optional(),
    PortBindings: portBindingsSchema.optional(),
    Privileged: z.literal(false).optional(),
    PublishAllPorts: z.boolean().optional(),
    ReadonlyRootfs: z.boolean().optional(),
    ShmSize: z.number().int().nonnegative().optional(),
  })
  .strict();

const containerCreateSchema = z
  .object({
    Hostname: boundedString.optional(),
    Domainname: boundedString.optional(),
    User: boundedString.optional(),
    AttachStdin: z.boolean().optional(),
    AttachStdout: z.boolean().optional(),
    AttachStderr: z.boolean().optional(),
    ExposedPorts: exposedPortsSchema.optional(),
    Tty: z.boolean().optional(),
    OpenStdin: z.boolean().optional(),
    StdinOnce: z.boolean().optional(),
    Env: stringList.optional(),
    Cmd: stringList.optional(),
    Healthcheck: healthcheckSchema.optional(),
    Image: z.string().min(1).max(512),
    WorkingDir: boundedString.optional(),
    Entrypoint: stringList.optional(),
    NetworkDisabled: z.literal(false).optional(),
    Labels: stringMap.optional(),
    StopSignal: boundedString.optional(),
    StopTimeout: z.number().int().nonnegative().max(3_600).optional(),
    Shell: stringList.optional(),
    HostConfig: requestedHostConfigSchema.optional(),
  })
  .strict();

const execCreateSchema = z
  .object({
    // Bollard's option structs serialize Rust `None` values as JSON null.
    // Treat null exactly like omission, then reconstruct the request below so
    // nulls and client-only fields never reach the daemon.
    AttachStdin: z.boolean().nullish(),
    AttachStdout: z.boolean().nullish(),
    AttachStderr: z.boolean().nullish(),
    DetachKeys: boundedString.nullish(),
    Tty: z.boolean().nullish(),
    Env: stringList.nullish(),
    Cmd: stringList.nullish(),
    Privileged: z.literal(false).nullish(),
    User: boundedString.nullish(),
    WorkingDir: boundedString.nullish(),
  })
  .strict();

const execStartSchema = z
  .object({
    Detach: z.literal(false).optional(),
    Tty: z.boolean().optional(),
    ConsoleSize: z.tuple([z.number().int(), z.number().int()]).optional(),
    // Bollard uses this to size its local output decoder, but also happens to
    // serialize it into the Engine request. Validate and discard it.
    OutputCapacity: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

export class DockerPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockerPolicyError";
  }
}

function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  const path = issue?.path.join(".") || "request";
  throw new DockerPolicyError(
    `${path}: ${issue?.message ?? "invalid Docker request"}`,
  );
}

function clampPositive(
  value: number | null | undefined,
  maximum: number,
): number {
  if (!value) return maximum;
  return Math.min(value, maximum);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDeepNoOp(value: unknown): boolean {
  if (value == null || value === false || value === "" || value === 0)
    return true;
  if (Array.isArray(value)) return value.every(isDeepNoOp);
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

function isRecursivelyNoOp(value: unknown): boolean {
  if (isRecord(value)) return Object.values(value).every(isRecursivelyNoOp);
  if (Array.isArray(value)) return value.every(isRecursivelyNoOp);
  return isDeepNoOp(value);
}

const CLIENT_ZERO_STRUCT_FIELDS = new Set([
  "LogConfig",
  "NetworkingConfig",
  "RestartPolicy",
]);

function isKnownClientDefault(name: string, value: unknown): boolean {
  if (name === "NetworkMode") return value === "" || value === "default";
  if (name === "MemorySwappiness") return value === -1;
  if (name === "RestartPolicy" && isRecord(value)) {
    return (
      (value.Name === "" || value.Name === "no") &&
      value.MaximumRetryCount === 0 &&
      Object.keys(value).every(
        (key) => key === "Name" || key === "MaximumRetryCount",
      )
    );
  }
  return false;
}

const MEANINGFUL_CONTAINER_FIELDS = new Set([
  "Hostname",
  "Domainname",
  "User",
  "AttachStdin",
  "AttachStdout",
  "AttachStderr",
  "ExposedPorts",
  "Tty",
  "OpenStdin",
  "StdinOnce",
  "Env",
  "Cmd",
  "Healthcheck",
  "Image",
  "WorkingDir",
  "Entrypoint",
  "NetworkDisabled",
  "Labels",
  "StopSignal",
  "StopTimeout",
  "Shell",
  "HostConfig",
]);

const MEANINGFUL_HOST_FIELDS = new Set([
  "AutoRemove",
  "CapDrop",
  "Init",
  "Memory",
  "NanoCpus",
  "PidsLimit",
  "PortBindings",
  "Privileged",
  "PublishAllPorts",
  "ReadonlyRootfs",
  "ShmSize",
]);

function discardClientZeroValues(
  value: unknown,
  meaningfulFields: ReadonlySet<string>,
): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).filter(([name, fieldValue]) => {
      if (fieldValue == null) return false;
      if (meaningfulFields.has(name)) return true;
      // Docker's Go client serializes a large API struct with dozens of null,
      // empty, false, and zero fields. Ignore only recursively empty values.
      // An unknown field containing any actual request survives this pass and
      // is then rejected by Zod's strict schema, preserving fail-closed API
      // compatibility without hard-coding every client version's zero fields.
      return !(
        isDeepNoOp(fieldValue) ||
        (CLIENT_ZERO_STRUCT_FIELDS.has(name) &&
          isRecursivelyNoOp(fieldValue)) ||
        isKnownClientDefault(name, fieldValue)
      );
    }),
  );
}

function normalizeContainerCreate(body: unknown): unknown {
  const container = discardClientZeroValues(body, MEANINGFUL_CONTAINER_FIELDS);
  if (!isRecord(container)) return container;
  const host = discardClientZeroValues(
    container.HostConfig,
    MEANINGFUL_HOST_FIELDS,
  );
  return { ...container, ...(isRecord(host) ? { HostConfig: host } : {}) };
}

function sanitizePortBindings(
  bindings: z.infer<typeof portBindingsSchema> | undefined,
): Record<string, Array<{ HostIp: string; HostPort: string }>> | undefined {
  if (!bindings) return undefined;

  return Object.fromEntries(
    Object.entries(bindings).map(([port, requested]) => [
      port,
      [
        {
          HostIp: "127.0.0.1",
          HostPort: requested?.[0]?.HostPort ?? "",
        },
      ],
    ]),
  );
}

/**
 * Return a new container-create body containing only the options agentbox is
 * willing to send to the host daemon. Never forward the parsed input object:
 * reconstructing it here makes new Docker API fields fail closed instead of
 * silently acquiring host privileges after a daemon or client upgrade.
 */
export function sanitizeContainerCreate(
  body: unknown,
  sessionId: string,
  networkName: string,
): Record<string, unknown> {
  const request = parseWithSchema(
    containerCreateSchema,
    normalizeContainerCreate(body),
  );
  const host = request.HostConfig ?? {};

  return {
    ...(request.Hostname == null ? {} : { Hostname: request.Hostname }),
    ...(request.Domainname == null ? {} : { Domainname: request.Domainname }),
    ...(request.User == null ? {} : { User: request.User }),
    ...(request.AttachStdin == null
      ? {}
      : { AttachStdin: request.AttachStdin }),
    ...(request.AttachStdout == null
      ? {}
      : { AttachStdout: request.AttachStdout }),
    ...(request.AttachStderr == null
      ? {}
      : { AttachStderr: request.AttachStderr }),
    ...(request.ExposedPorts == null
      ? {}
      : { ExposedPorts: request.ExposedPorts }),
    ...(request.Tty == null ? {} : { Tty: request.Tty }),
    ...(request.OpenStdin == null ? {} : { OpenStdin: request.OpenStdin }),
    ...(request.StdinOnce == null ? {} : { StdinOnce: request.StdinOnce }),
    ...(request.Env == null ? {} : { Env: request.Env }),
    ...(request.Cmd == null ? {} : { Cmd: request.Cmd }),
    ...(request.Healthcheck == null
      ? {}
      : { Healthcheck: request.Healthcheck }),
    Image: request.Image,
    ...(request.WorkingDir == null ? {} : { WorkingDir: request.WorkingDir }),
    ...(request.Entrypoint == null ? {} : { Entrypoint: request.Entrypoint }),
    Labels: {
      ...(request.Labels ?? {}),
      [AGENTBOX_DOCKER_LABEL]: sessionId,
    },
    ...(request.StopSignal == null ? {} : { StopSignal: request.StopSignal }),
    ...(request.StopTimeout == null
      ? {}
      : { StopTimeout: request.StopTimeout }),
    ...(request.Shell == null ? {} : { Shell: request.Shell }),
    HostConfig: {
      AutoRemove: host.AutoRemove ?? false,
      CapDrop: host.CapDrop ?? [],
      Init: host.Init ?? true,
      Memory: clampPositive(host.Memory, MAX_MEMORY_BYTES),
      NanoCpus: clampPositive(host.NanoCpus, MAX_NANO_CPUS),
      NetworkMode: networkName,
      PidsLimit: clampPositive(host.PidsLimit, MAX_PIDS),
      ...(host.PortBindings == null
        ? {}
        : { PortBindings: sanitizePortBindings(host.PortBindings) }),
      Privileged: false,
      PublishAllPorts: host.PublishAllPorts ?? false,
      ReadonlyRootfs: host.ReadonlyRootfs ?? false,
      SecurityOpt: ["no-new-privileges"],
      ShmSize: clampPositive(host.ShmSize, MAX_SHM_BYTES),
    },
  };
}

export function sanitizeExecCreate(body: unknown): Record<string, unknown> {
  const request = parseWithSchema(execCreateSchema, body);
  return {
    ...(request.AttachStdin == null
      ? {}
      : { AttachStdin: request.AttachStdin }),
    ...(request.AttachStdout == null
      ? {}
      : { AttachStdout: request.AttachStdout }),
    ...(request.AttachStderr == null
      ? {}
      : { AttachStderr: request.AttachStderr }),
    ...(request.DetachKeys == null ? {} : { DetachKeys: request.DetachKeys }),
    ...(request.Tty == null ? {} : { Tty: request.Tty }),
    ...(request.Env == null ? {} : { Env: request.Env }),
    ...(request.Cmd == null ? {} : { Cmd: request.Cmd }),
    Privileged: false,
    ...(request.User == null ? {} : { User: request.User }),
    ...(request.WorkingDir == null ? {} : { WorkingDir: request.WorkingDir }),
  };
}

export function sanitizeExecStart(body: unknown): Record<string, unknown> {
  const request = parseWithSchema(execStartSchema, body);
  return {
    ...(request.Detach === undefined ? {} : { Detach: request.Detach }),
    ...(request.Tty === undefined ? {} : { Tty: request.Tty }),
    ...(request.ConsoleSize === undefined
      ? {}
      : { ConsoleSize: request.ConsoleSize }),
  };
}

export function validateImageReference(value: string): string {
  if (
    value.length === 0 ||
    value.length > 512 ||
    /[\s\0-\x1f\x7f]/.test(value) ||
    value.includes("://") ||
    value.startsWith("/")
  ) {
    throw new DockerPolicyError("invalid image reference");
  }
  return value;
}

/**
 * Normalize the familiar short forms accepted by Docker to a stable reference
 * for session-ownership checks. The daemon may expand `alpine` to
 * `docker.io/library/alpine` while pulling, then receive the short form again
 * when the client creates the container.
 */
export function canonicalImageReference(value: string): string {
  const reference = validateImageReference(value);
  const digestSeparator = reference.indexOf("@");
  const nameAndTag =
    digestSeparator < 0 ? reference : reference.slice(0, digestSeparator);
  const digest =
    digestSeparator < 0 ? "" : reference.slice(digestSeparator).toLowerCase();
  const lastSlash = nameAndTag.lastIndexOf("/");
  const lastColon = nameAndTag.lastIndexOf(":");
  const hasTag = lastColon > lastSlash;
  const name = hasTag ? nameAndTag.slice(0, lastColon) : nameAndTag;
  const tag = hasTag ? nameAndTag.slice(lastColon) : digest ? "" : ":latest";
  const components = name.split("/");
  const first = components[0] ?? "";
  const hasRegistry =
    components.length > 1 &&
    (first.includes(".") || first.includes(":") || first === "localhost");
  const registry = hasRegistry
    ? first === "index.docker.io"
      ? "docker.io"
      : first.toLowerCase()
    : "docker.io";
  const repository = (hasRegistry ? components.slice(1) : components).join("/");
  const qualifiedRepository =
    registry === "docker.io" && !repository.includes("/")
      ? `library/${repository}`
      : repository;
  return `${registry}/${qualifiedRepository.toLowerCase()}${tag}${digest}`;
}

export function imageReferenceFromPullUrl(url: URL): string {
  const allowed = new Set([
    "fromImage",
    "fromSrc",
    "repo",
    "tag",
    "platform",
    "changes",
  ]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key))
      throw new DockerPolicyError(`unsupported image-pull option ${key}`);
  }
  // Bollard serializes the import-only string options even for a pull. Empty
  // values are harmless, but accepting a source, repository, or Dockerfile
  // change would turn this endpoint into the much broader image-import API.
  for (const key of ["fromSrc", "repo", "changes"]) {
    if (url.searchParams.get(key))
      throw new DockerPolicyError(`image-import option ${key} is blocked`);
  }

  const image = validateImageReference(url.searchParams.get("fromImage") ?? "");
  const tag = url.searchParams.get("tag");
  const tagged =
    !tag || image.includes("@") || /:[^/]+$/.test(image)
      ? image
      : `${image}:${tag}`;
  return canonicalImageReference(tagged);
}

export class DockerSessionState {
  readonly sessionId = randomUUID();
  readonly networkName = `agentbox-${this.sessionId}`;
  readonly containers = new Set<string>();
  readonly containerAliases = new Map<string, string>();
  readonly execs = new Set<string>();
  readonly pulledImages = new Set<string>();

  ownsContainer(id: string): boolean {
    return this.containers.has(id);
  }

  addContainer(id: string, alias?: string): void {
    this.containers.add(id);
    if (alias) this.containerAliases.set(alias, id);
  }

  resolveContainer(identifier: string): string | undefined {
    if (this.containers.has(identifier)) return identifier;
    const alias = this.containerAliases.get(identifier);
    if (alias) return alias;
    const matches = [...this.containers].filter((id) =>
      id.startsWith(identifier),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  removeContainer(id: string): void {
    this.containers.delete(id);
    for (const [alias, target] of this.containerAliases) {
      if (target === id) this.containerAliases.delete(alias);
    }
  }

  ownsExec(id: string): boolean {
    return this.execs.has(id);
  }
}
