/**
 * Resolve a Linux process jail from an allowlist, starting with an empty root.
 * Only the checkout, selected toolchains, and explicit grants are mounted.
 * Paths are canonicalized before checking overlaps: aliases must not turn a
 * read-only grant or launcher policy into writable data.
 */
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { fail } from "./errors.js";
import { expandHome } from "./system.js";

export const filesystemSchema = z
  .object({
    read_only: z.array(z.string().min(1)).default([]),
    read_write: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const limitsSchema = z
  .object({
    // systemd accepts byte counts and binary K/M/G/T suffixes.
    memory: z
      .string()
      .regex(/^[1-9][0-9]*[KMGT]?$/)
      .optional(),
    tasks: z.number().int().positive().max(1_000_000).optional(),
    cpu: z.number().positive().max(100_000).optional(),
  })
  .strict();

export const networkSchema = z.enum(["none", "host"]);
export const settingsSchema = z
  .object({
    filesystem: filesystemSchema.default({}),
    network: networkSchema.default("none"),
    docker: z.boolean().default(false),
    docker_data: z.string().min(1).optional(),
    limits: limitsSchema.default({}),
  })
  .strict();

export type ResourceLimits = z.infer<typeof limitsSchema>;
export type NetworkMode = z.infer<typeof networkSchema>;
export type Mount = { path: string; writable: boolean };
export type LoadedPolicy = {
  label: string;
  cwd: string;
  home: string;
  network: NetworkMode;
  docker: boolean;
  dockerData?: string;
  limits: ResourceLimits;
  mounts: Mount[];
  protectedPaths: string[];
  filesystemGrants: { readOnly: string[]; readWrite: string[] };
};

export const EMBEDDED_POLICY = settingsSchema.parse({});

export function isWithin(path: string, parent: string): boolean {
  return (
    path === parent || path.startsWith(parent === "/" ? "/" : `${parent}/`)
  );
}

// Resolve even an absent policy file through its existing ancestors. This also
// catches a config reached through a symlink inside a writable checkout.
export function canonicalPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  if (parent === path) return path;
  return join(canonicalPath(parent), path.slice(parent.length));
}

function grantPath(path: string, cwd: string): string {
  const absolute = resolve(cwd, expandHome(path));
  let canonical: string;
  try {
    canonical = realpathSync(absolute);
    const stat = statSync(canonical);
    if (!stat.isFile() && !stat.isDirectory()) {
      fail(
        `filesystem grants must name regular files or directories: ${absolute}`,
      );
    }
  } catch (error) {
    fail(`cannot grant ${absolute}: ${String(error)}`);
  }
  // Never expose namespace handles, devices or the user's service manager.
  for (const reserved of ["/proc", "/sys", "/dev", "/run"]) {
    if (isWithin(canonical, reserved) || isWithin(reserved, canonical)) {
      fail(`cannot grant namespace or service path ${canonical}`);
    }
  }
  if (["/tmp", "/var/tmp"].includes(canonical))
    fail(`grant a specific subdirectory, not ${canonical}`);
  return canonical;
}

function gitCommonDirectory(cwd: string): string | undefined {
  const result = spawnSync(
    "git",
    ["-C", cwd, "rev-parse", "--git-common-dir"],
    {
      encoding: "utf8",
      timeout: 5000,
      env: {
        PATH: process.env.PATH,
        HOME: homedir(),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status !== 0) return undefined;
  return grantPath(result.stdout.trim(), cwd);
}

export function loadPolicy(
  settingsPath: string | undefined,
  cwd: string,
  additions: {
    filesystem?: {
      readOnly?: readonly string[];
      readWrite?: readonly string[];
    };
    protectedWritePaths?: readonly string[];
    network?: NetworkMode;
    docker?: boolean;
    dockerData?: string;
    limits?: ResourceLimits;
  } = {},
): LoadedPolicy {
  cwd = realpathSync(cwd);
  const home = realpathSync(homedir());
  if (
    isWithin(home, cwd) ||
    ["/usr", "/etc", "/var", "/opt", "/tmp"].includes(cwd)
  ) {
    fail("launch from a checkout directory, not a home or system directory");
  }
  let config = structuredClone(EMBEDDED_POLICY);
  let label = "(embedded)";
  const protectedInputs = [...(additions.protectedWritePaths ?? [])].map(
    (path) => resolve(cwd, expandHome(path)),
  );
  if (settingsPath) {
    label = resolve(cwd, expandHome(settingsPath));
    try {
      config = settingsSchema.parse(JSON.parse(readFileSync(label, "utf8")));
    } catch (error) {
      fail(
        `invalid agentbox settings at ${label}: ${String(error)}. Legacy SRT policies must be migrated; see --print-settings.`,
      );
    }
    protectedInputs.push(label);
  }

  const readWrite = [
    ...new Set(
      [
        cwd,
        ...config.filesystem.read_write,
        ...(additions.filesystem?.readWrite ?? []),
      ].map((path) => grantPath(path, cwd)),
    ),
  ];
  const docker = additions.docker ?? config.docker;
  const rawDockerData = docker
    ? (additions.dockerData ?? config.docker_data)
    : undefined;
  const dockerData = rawDockerData ? grantPath(rawDockerData, cwd) : undefined;
  if (dockerData) {
    if (!statSync(dockerData).isDirectory())
      fail("docker_data must be an existing directory");
    if (!readWrite.includes(dockerData)) readWrite.push(dockerData);
  }
  const common = gitCommonDirectory(cwd);
  if (common && !readWrite.some((path) => isWithin(common, path)))
    readWrite.push(common);
  const readOnly = [
    ...new Set(
      [
        ...config.filesystem.read_only,
        ...(additions.filesystem?.readOnly ?? []),
      ].map((path) => grantPath(path, cwd)),
    ),
  ];
  for (const writable of readWrite) {
    if (isWithin(home, writable))
      fail(`cannot expose the whole home directory: ${writable}`);
    for (const system of [
      "/usr",
      "/etc",
      "/bin",
      "/sbin",
      "/lib",
      "/lib64",
      "/opt",
    ]) {
      if (isWithin(writable, system))
        fail(`system toolchains must be read-only: ${writable}`);
    }
    if (readOnly.some((path) => isWithin(writable, path))) {
      fail(`read-write grant conflicts with a read-only grant: ${writable}`);
    }
  }

  // Include the Node installation running this launcher (e.g. a versioned mise
  // installation). No other user tool/config/cache directory is auto-granted.
  const node = realpathSync(process.execPath);
  const nodeRoot = dirname(node).endsWith("/bin")
    ? dirname(dirname(node))
    : node;
  const mounts: Mount[] = [
    ...readWrite.map((path) => ({ path, writable: true })),
    ...readOnly.map((path) => ({ path, writable: false })),
  ];
  if (
    !isWithin(node, "/usr") &&
    !mounts.some(({ path, writable }) => !writable && isWithin(nodeRoot, path))
  ) {
    mounts.push({ path: nodeRoot, writable: false });
  }
  // Parent mounts first; explicit read-only children override writable parents.
  mounts.sort(
    (a, b) =>
      a.path.split("/").length - b.path.split("/").length ||
      a.path.localeCompare(b.path),
  );

  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const protectedPaths = protectedInputs.map(canonicalPath);
  // Binding a symlink target does not stop replacing the symlink itself.
  // Freeze a writable directory containing a launcher-policy symlink too.
  for (const input of protectedInputs) {
    for (let path = input; dirname(path) !== path; path = dirname(path)) {
      if (!existsSync(path) || !lstatSync(path).isSymbolicLink()) continue;
      const parent = canonicalPath(dirname(path));
      if (readWrite.some((root) => isWithin(parent, root)))
        protectedPaths.push(parent);
    }
  }
  if (docker) {
    // The optional Docker supervisor executes inside the jail. Its code is a
    // read-only mount, including when agentbox is run from its own checkout.
    mounts.push({ path: join(packageRoot, "dist"), writable: false });
  }
  for (const entry of [
    "dist",
    "bin",
    "node_modules",
    "package.json",
    "package-lock.json",
  ]) {
    protectedPaths.push(canonicalPath(join(packageRoot, entry)));
  }
  const protections = new Set<string>();
  for (let path of protectedPaths) {
    if (existsSync(path) && statSync(path).isFile() && statSync(path).nlink > 1)
      fail(`protected launcher file has hard-link aliases: ${path}`);
    if (!mounts.some((mount) => mount.writable && isWithin(path, mount.path)))
      continue;
    // An absent file cannot be bind-mounted without creating a host file. Freeze
    // its nearest existing ancestor instead, or reject an unusable workspace.
    while (!existsSync(path)) path = dirname(path);
    if (path === cwd)
      fail(
        "launcher configuration would freeze the checkout; use an existing, non-symlinked config outside it",
      );
    protections.add(path);
  }

  // A read-only file bind prevents writes/unlink, but not renaming one of its
  // writable ancestors and installing a replacement at the original pathname.
  // Anchor every such ancestor with a bind mount as well, without freezing its
  // unrelated contents. Never create placeholders in the host checkout.
  for (const protection of [
    ...protections,
    ...mounts.filter((mount) => !mount.writable).map((mount) => mount.path),
  ]) {
    let parent = dirname(protection);
    while (
      mounts.some((mount) => mount.writable && isWithin(parent, mount.path))
    ) {
      if (!mounts.some((mount) => mount.path === parent)) {
        mounts.push({
          path: parent,
          writable: !readOnly.some((path) => isWithin(parent, path)),
        });
      }
      parent = dirname(parent);
    }
  }
  mounts.sort(
    (a, b) =>
      a.path.split("/").length - b.path.split("/").length ||
      a.path.localeCompare(b.path),
  );

  return {
    label,
    cwd,
    home,
    network: additions.network ?? config.network,
    docker,
    dockerData,
    limits: limitsSchema.parse({ ...config.limits, ...additions.limits }),
    mounts,
    protectedPaths: [...protections],
    filesystemGrants: { readOnly, readWrite },
  };
}

export function printableEmbeddedPolicy(): string {
  return `${JSON.stringify(EMBEDDED_POLICY, null, 2)}\n`;
}
