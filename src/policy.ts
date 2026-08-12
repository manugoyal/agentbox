import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SandboxRuntimeConfigSchema,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";

import { fail } from "./errors.js";
import { expandHome, findExecutable, runChecked } from "./system.js";

// Reads are deny-then-allow and writes are allow-only. Denying the home
// directory and adding back the handful of useful tool directories keeps
// credential stores private by default, including ones added in the future.
// Relative paths resolve against the launch directory, making the policy
// project-neutral.
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
      // OrbStack points /var/run/docker.sock at this target under $HOME.
      "~/.orbstack/run/docker.sock",
      "~/.rustup",
      "~/.cache",
      "~/Library/Caches",
      "~/.gitconfig",
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
      "~/.claude",
      "~/.claude.json",
      "~/.codex",
      "~/.cache",
      "~/Library/Caches",
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
    allowedDomains: [
      // Agent APIs and authentication.
      "*.anthropic.com",
      "claude.ai",
      "*.claude.ai",
      "claude.com",
      "*.claude.com",
      "openai.com",
      "*.openai.com",
      "chatgpt.com",
      "*.chatgpt.com",
      // Source hosting.
      "github.com",
      "*.github.com",
      "*.windows.net",
      "*.githubusercontent.com",
      "*.github.io",
      // Package registries and tool downloads.
      "registry.npmjs.org",
      "*.npmjs.org",
      "pypi.org",
      "*.pypi.org",
      "files.pythonhosted.org",
      "*.pythonhosted.org",
      "astral.sh",
      "*.astral.sh",
      "*.jdx.dev",
      "bcr.bazel.build",
      "registry.terraform.io",
      "releases.hashicorp.com",
      "*.hashicorp.com",
      "formulae.brew.sh",
      "ghcr.io",
      "*.ghcr.io",
      // Cloud and observability services.
      "*.amazonaws.com",
      "*.amazon.com",
      "*.cloudfront.net",
      "datadoghq.com",
      "*.datadoghq.com",
      "datadoghq.eu",
      "*.datadoghq.eu",
      "ddog-gov.com",
      "*.ddog-gov.com",
      "braintrust.dev",
      "*.braintrust.dev",
      "braintrustdata.com",
      "*.braintrustdata.com",
      "1password.com",
      "*.1password.com",
      // Documentation commonly fetched by coding agents.
      "*.python.org",
      "*.readthedocs.io",
      "readthedocs.io",
      "developer.mozilla.org",
      "stackoverflow.com",
      "*.stackoverflow.com",
      "*.stackexchange.com",
      "*.wikipedia.org",
      "opentelemetry.io",
      "*.opentelemetry.io",
      "deepwiki.com",
    ],
    deniedDomains: [],
    // Agentbox deliberately has one network model: destinations must match the
    // explicit list above. No permission callback is installed, and this flag
    // prevents a future callback from accidentally weakening that invariant.
    strictAllowlist: true,
    allowLocalBinding: true,
    // Go asks trustd to verify certificates. Without this Mach lookup, gh and
    // Terraform report misleading TLS or authentication failures on macOS.
    allowMachLookup: ["com.apple.trustd.agent"],
    // Unix sockets do not provide network egress. This is required for Docker
    // and for coding agents that run their own nested SRT instance.
    allowAllUnixSockets: true,
  },
  ignoreViolations: {},
  allowPty: true,
  enableWeakerNestedSandbox: true,
} satisfies SandboxRuntimeConfig;

export type LoadedPolicy = {
  config: SandboxRuntimeConfig;
  label: string;
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

  // Keep the network policy deterministic even when a custom settings file
  // omits the flag. Agentbox never installs SRT's "ask" callback, so unmatched
  // hosts would still be denied; making it explicit guards that design choice.
  config.network.strictAllowlist = true;

  // All runtime modules live together in dist/. Protecting that directory
  // prevents a child launched from the agentbox source tree from rewriting the
  // code or embedded policy used on its next launch.
  const runtimeDirectory = dirname(fileURLToPath(import.meta.url));
  config.filesystem.allowRead ??= [];
  config.filesystem.allowRead.push(runtimeDirectory);
  config.filesystem.denyWrite.push(runtimeDirectory);

  return { config, label };
}

export function printableEmbeddedPolicy(): string {
  return `${JSON.stringify(EMBEDDED_POLICY, null, 2)}\n`;
}
