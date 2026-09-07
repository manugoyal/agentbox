/**
 * A daemon-free bubblewrap jail. Build an empty filesystem, add only approved
 * mounts, and execute the original argv directly. Private PID/proc, IPC, UTS,
 * user and cgroup namespaces apply to the entire process tree. Bubblewrap's
 * PID 1 reaps children and the kernel kills descendants when that namespace
 * exits. No Docker socket or user service-manager socket is mounted.
 *
 * Optional aggregate limits use a transient systemd user scope. The systemd
 * client stays outside the jail; its bus and ambient environment never enter.
 */
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runChild } from "./child-process.js";
import { dockerMappingSetup } from "./docker.js";
import { fail } from "./errors.js";
import type { LoadedPolicy } from "./policy.js";

// Deliberately exclude /etc as a whole: it can contain workstation secrets.
const SYSTEM_CONFIG = [
  "/etc/ld.so.cache",
  "/etc/ld.so.conf",
  "/etc/ld.so.conf.d",
  "/etc/alternatives",
  "/etc/ssl/certs",
  "/etc/ca-certificates",
  "/etc/ca-certificates.conf",
  "/etc/pki/tls/certs",
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/localtime",
  "/etc/timezone",
];

export function sandboxArguments(
  policy: LoadedPolicy,
  command: readonly string[],
): string[] {
  if (!command[0]) fail("a command is required");
  const args = [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup",
    "--new-session",
    "--die-with-parent",
    "--hostname",
    "agentbox",
  ];
  if (policy.docker)
    args.push(
      "--uid",
      "0",
      "--gid",
      "0",
      "--cap-add",
      "ALL",
      "--userns-block-fd",
      "4",
      "--info-fd",
      "5",
    );
  else args.push("--cap-drop", "ALL", "--disable-userns");
  if (policy.network === "none") args.push("--unshare-net");

  // /usr is the distro's installed tools/libraries, including /usr/local.
  args.push("--ro-bind", "/usr", "/usr");
  for (const path of ["/bin", "/sbin", "/lib", "/lib64"]) {
    if (!existsSync(path)) continue;
    if (lstatSync(path).isSymbolicLink())
      args.push("--symlink", readlinkSync(path), path);
    else args.push("--ro-bind", path, path);
  }
  for (const path of SYSTEM_CONFIG) {
    if (existsSync(path)) args.push("--ro-bind", realpathSync(path), path);
  }
  args.push(
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/var/tmp",
    "--tmpfs",
    "/run",
    "--symlink",
    "/run",
    "/var/run",
    "--dir",
    policy.home,
    "--perms",
    "0700",
    "--dir",
    `/run/user/${process.getuid!()}`,
  );
  if (policy.docker) {
    args.push("--ro-bind", "/sys", "/sys");
    if (policy.network !== "none")
      args.push("--dev-bind", "/dev/net/tun", "/dev/net/tun");
  }
  for (const mount of policy.mounts) {
    args.push(mount.writable ? "--bind" : "--ro-bind", mount.path, mount.path);
  }
  for (const path of policy.protectedPaths) args.push("--ro-bind", path, path);
  // The private home is writable; files persist only through explicit mounts.
  // The guest home, tmp and runtime directories are never inherited.
  args.push("--chdir", policy.cwd, "--");
  if (policy.docker)
    args.push(
      process.execPath,
      fileURLToPath(new URL("./docker-runner.js", import.meta.url)),
      "outer",
      policy.network,
    );
  args.push(...command);
  return args;
}

export function sandboxEnvironment(
  policy: LoadedPolicy,
  values: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "TERM",
    "COLORTERM",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "USER",
    "LOGNAME",
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  // Preserve tool lookup without granting filesystem access to hidden entries.
  // The current Node installation is mounted read-only by loadPolicy.
  environment.PATH = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  environment.LANG ??= "C.UTF-8";
  Object.assign(
    environment,
    {
      HOME: policy.home,
      PWD: policy.cwd,
      SHELL: "/bin/bash",
      TMPDIR: "/tmp",
      XDG_CACHE_HOME: join(policy.home, ".cache"),
      XDG_CONFIG_HOME: join(policy.home, ".config"),
      XDG_DATA_HOME: join(policy.home, ".local", "share"),
      XDG_STATE_HOME: join(policy.home, ".local", "state"),
      XDG_RUNTIME_DIR: `/run/user/${process.getuid!()}`,
    },
    values,
  );
  // These are structural sandbox paths, not inherited host configuration.
  environment.HOME = policy.home;
  environment.PWD = policy.cwd;
  environment.TMPDIR = "/tmp";
  return environment;
}

export function checkPlatform(): void {
  if (process.platform !== "linux")
    fail("agentbox requires Linux; run it inside your workstation VM");
  if (process.getuid!() === 0)
    fail("run agentbox as an ordinary Linux user, not root");
  if (!existsSync("/usr/bin/bwrap"))
    fail("bubblewrap is required: install the bubblewrap package");
}

export async function launchSandbox(
  policy: LoadedPolicy,
  command: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  checkPlatform();
  for (const [name, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value?.includes("\0"))
      fail(`invalid sandbox environment entry: ${name}`);
  }
  const setup = policy.docker ? dockerMappingSetup() : undefined;
  let executable = "/usr/bin/bwrap";
  let args = [
    "--clearenv",
    "--args",
    "3",
    ...sandboxArguments(policy, command),
  ];
  // Ubuntu's stock bwrap AppArmor profile denies capabilities to *all* child
  // programs. Docker needs an explicit application profile; never weaken the
  // system-wide userns sysctl or silently fall back to a different sandbox.
  if (
    policy.docker &&
    existsSync("/sys/module/apparmor/parameters/enabled") &&
    readFileSync("/sys/module/apparmor/parameters/enabled", "utf8").trim() ===
      "Y"
  ) {
    executable = "/usr/local/libexec/agentbox-bwrap";
    if (!existsSync(executable))
      fail(
        "Docker mode needs the agentbox AppArmor entrypoint; see README.md Docker setup",
      );
  }
  const scoped = policy.docker || Object.keys(policy.limits).length > 0;
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/usr/sbin:/bin:/sbin",
    LANG: "C.UTF-8",
  };
  if (scoped) {
    if (!existsSync("/usr/bin/systemd-run"))
      fail(
        "configured resource limits require systemd-run and an active systemd user manager",
      );
    const properties: string[] = [];
    if (policy.docker) properties.push("Delegate=yes");
    if (policy.limits.memory)
      properties.push(`MemoryMax=${policy.limits.memory}`, "MemorySwapMax=0");
    if (policy.limits.tasks) properties.push(`TasksMax=${policy.limits.tasks}`);
    if (policy.limits.cpu) properties.push(`CPUQuota=${policy.limits.cpu}%`);
    // Scope mode runs the client locally with exact argv and preserves stdio.
    // FD 3 carries the allowed environment as bwrap args, keeping secrets out
    // of both process argv and systemd's unit properties/logs.
    args = [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      "--expand-environment=no",
      ...properties.flatMap((property) => ["--property", property]),
      "--",
      executable,
      ...args,
    ];
    executable = "/usr/bin/systemd-run";
    env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
    env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS;
  }
  // Carry environment data on a private pipe, never in argv or the loader
  // environment of host setup tools. Bwrap closes FD 3 before the command.
  const childEnvironment = policy.docker
    ? {
        HOME: policy.home,
        PATH: "/usr/bin:/usr/sbin:/bin:/sbin",
        LANG: "C.UTF-8",
        // The privileged setup runner must not interpret user NODE_OPTIONS,
        // LD_PRELOAD, etc. Decode this only after entering the inner namespace.
        AGENTBOX_INTERNAL_ENV: Buffer.from(
          JSON.stringify(environment),
        ).toString("base64url"),
        AGENTBOX_INTERNAL_DOCKER_DATA: policy.dockerData ?? "/var/lib/docker",
      }
    : environment;
  const environmentArgs = Object.entries(childEnvironment).flatMap(
    ([name, value]) => (value === undefined ? [] : ["--setenv", name, value]),
  );
  return runChild(
    executable,
    args,
    {
      cwd: policy.cwd,
      env,
      stdio: policy.docker
        ? ["inherit", "inherit", "inherit", "pipe", "pipe", "pipe"]
        : ["inherit", "inherit", "inherit", "pipe"],
    },
    Buffer.from(`${environmentArgs.join("\0")}\0`),
    setup,
  );
}
