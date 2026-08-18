/**
 * The default SRT policy and the loader for user-supplied replacements.
 *
 * The embedded policy treats the current checkout and selected tool/cache
 * directories as the writable development area while denying the rest of the
 * user's home directory. Outbound IP networking is intentionally unrestricted,
 * but Unix sockets and macOS Mach services remain narrow host-service
 * boundaries. The runtime and launcher settings are protected so a sandboxed
 * command cannot silently weaken a later launch.
 *
 * A custom settings file replaces the embedded policy rather than extending
 * it. Callers should therefore treat custom settings as a complete security
 * policy and review them independently.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SandboxRuntimeConfigSchema,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";

import { fail } from "./errors.js";
import { expandHome, findExecutable, runChecked } from "./system.js";

// Reads are deny-then-allow and writes are allow-only. Relative paths resolve
// against the launch directory, keeping the policy project-neutral.
export const EMBEDDED_POLICY = {
  filesystem: {
    denyRead: [
      "~",
      // Cargo keeps registry tokens alongside otherwise useful tool state.
      "~/.cargo/credentials",
      "~/.cargo/credentials.toml",
    ],
    allowRead: [
      ".",
      "~/.cargo",
      "~/.claude",
      "~/.claude.json",
      "~/.codex",
      "~/.local",
      "~/.rustup",
      "~/.cache",
      "~/Library/Caches",
      // Reuse pnpm's content-addressed stores without exposing sibling global
      // executables for writes.
      "~/Library/pnpm/store",
      "~/.local/share/pnpm/store",
      // npm and pnpm use this for registry and store configuration. It is
      // intentionally read-only; agents should not be able to persist changes
      // to the user's package-manager defaults.
      "~/.npmrc",
      "~/.gitconfig",
      "~/.config/git/ignore",
      "~/.zshenv",
      "~/.zprofile",
      "~/.zshrc",
      "~/.config/mise",
    ],
    allowWrite: [
      // Full-screen terminal programs need the terminal devices and ioctls.
      "/dev/stdout",
      "/dev/stderr",
      "/dev/null",
      "/dev/tty",
      "/dev/dtracehelper",
      "/dev/autofs_nowait",
      ".",
      // Registry downloads and unpacked crate sources are shared with Cargo
      // outside the sandbox. Keep Cargo config, credentials, and bin read-only.
      "~/.cargo/registry",
      "~/.claude",
      "~/.claude.json",
      "~/.codex",
      "~/.cache",
      "~/Library/Caches",
      "~/Library/pnpm/store",
      "~/.local/share/pnpm/store",
      "/tmp",
      "/private/tmp",
      "/private/var/folders",
    ],
    // These files sit inside writable directories. denyWrite takes precedence
    // and prevents a sandboxed agent from widening its next launch policy.
    denyWrite: [
      "~/.claude/settings.json",
      "~/.codex/config.toml",
      "~/.codex/hooks.json",
      "./.claude/settings.json",
      "./.claude/settings.local.json",
      "./.codex/config.toml",
      "./.codex/hooks.json",
    ],
  },
  network: {
    // Keep SRT's restricted-network profile so Unix-domain sockets remain
    // path-scoped below. Agentbox separately adds direct outbound IP access on
    // macOS for build tools that clear proxy variables. The wildcard keeps
    // proxy-aware tools unrestricted too.
    allowedDomains: ["*"],
    deniedDomains: [],
    // No permission callback is installed. Make the wildcard deterministic.
    strictAllowlist: true,
    allowLocalBinding: true,
    // Go asks trustd to verify certificates. Without this Mach lookup, gh and
    // Terraform report misleading TLS or authentication failures on macOS.
    allowMachLookup: [
      "com.apple.trustd.agent",
      // Directory fs.watch on macOS is implemented through FSEvents. Without
      // this lookup libuv reports the service denial as the misleading EMFILE
      // (too many open files). Seatbelt still applies the filesystem policy to
      // the paths a process asks FSEvents to observe.
      "com.apple.FSEvents",
    ],
    // Some development tools use Unix sockets for private, same-process-tree
    // IPC. In particular, tsx creates a temporary socket beneath TMPDIR, which
    // SRT sets to /tmp/claude. Limit that permission to SRT's dedicated temp
    // subtree: allowing all of /tmp could expose unrelated host services (for
    // example an SSH agent), while allowing every Unix socket could expose the
    // raw host Docker daemon and bypass agentbox's Lima VM boundary.
    //
    // SRT can enforce this path allowlist on macOS. On Linux its seccomp filter
    // cannot inspect socket paths, so allowUnixSockets is intentionally ignored
    // and Unix sockets remain blocked unless allowAllUnixSockets is enabled.
    // Direct IP egress resolves names through macOS's fixed DNS socket. This
    // exposes only the system resolver, not arbitrary host service sockets.
    allowUnixSockets: ["/tmp/claude", "/private/var/run/mDNSResponder"],
    allowAllUnixSockets: false,
  },
  ignoreViolations: {},
  allowPty: true,
  enableWeakerNestedSandbox: true,
} satisfies SandboxRuntimeConfig;

export type LoadedPolicy = {
  config: SandboxRuntimeConfig;
  label: string;
  unrestrictedIpEgress: boolean;
};

function cloneEmbeddedPolicy(): SandboxRuntimeConfig {
  return structuredClone(EMBEDDED_POLICY);
}

function gitCommonDirectory(cwd: string): string | undefined {
  if (!findExecutable("git")) return undefined;

  try {
    const rawPath = runChecked(
      ["git", "-C", cwd, "rev-parse", "--git-common-dir"],
      {
        GIT_DIR: null,
        GIT_COMMON_DIR: null,
        GIT_WORK_TREE: null,
      },
    ).trim();
    return resolve(cwd, rawPath);
  } catch {
    return undefined;
  }
}

/**
 * Load and finish the policy used for this session.
 *
 * The installed JavaScript directory is denied for writes because it contains
 * the policy and launcher implementation. This is the npm-package equivalent
 * of the Python version denying writes to its own single-file executable.
 */
export function loadPolicy(
  settingsPath: string | undefined,
  cwd: string,
): LoadedPolicy {
  let config: SandboxRuntimeConfig;
  let label: string;

  if (settingsPath) {
    const path = resolve(expandHome(settingsPath));
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      fail(`could not read srt settings at ${path}: ${String(error)}`);
    }

    try {
      config = SandboxRuntimeConfigSchema.parse(JSON.parse(raw));
    } catch (error) {
      fail(`invalid srt settings at ${path}: ${String(error)}`);
    }
    label = path;
    config.filesystem.denyWrite.push(path);
  } else {
    config = cloneEmbeddedPolicy();
    label = "(embedded)";

    const commonDirectory = gitCommonDirectory(cwd);
    if (commonDirectory) {
      config.filesystem.allowRead ??= [];
      config.filesystem.allowRead.push(commonDirectory);
      config.filesystem.allowWrite.push(commonDirectory);
    }
  }

  // Keep custom network policy deterministic. Agentbox never installs SRT's
  // "ask" callback, so unmatched hosts are denied when a custom allowlist is
  // supplied.
  config.network.strictAllowlist = true;

  // A wildcard with no denies is the explicit opt-in to direct IP egress.
  // Custom SRT settings can retain domain filtering by supplying a narrower
  // allowlist or any deny rule.
  const unrestrictedIpEgress =
    config.network.allowedDomains.includes("*") &&
    config.network.deniedDomains.length === 0;

  // All runtime modules live together in dist/. Protecting that directory
  // prevents a child launched from the agentbox source tree from rewriting the
  // code or embedded policy used on its next launch.
  const runtimeDirectory = dirname(fileURLToPath(import.meta.url));
  config.filesystem.allowRead ??= [];
  config.filesystem.allowRead.push(runtimeDirectory);
  config.filesystem.denyWrite.push(runtimeDirectory);

  return { config, label, unrestrictedIpEgress };
}

export function printableEmbeddedPolicy(): string {
  return `${JSON.stringify(EMBEDDED_POLICY, null, 2)}\n`;
}
