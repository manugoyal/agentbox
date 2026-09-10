/**
 * Keep Agentbox compatibility shims first on PATH inside Codex tool commands.
 *
 * Codex snapshots the user's shell environment and uses that snapshot when it
 * runs commands. Shell tool managers can reorder PATH while that snapshot is
 * built, moving the real Bazel executable ahead of Agentbox's launch-scoped
 * shim. Bazel then drops DOCKER_HOST from test actions and Docker clients fall
 * back to the intentionally unavailable host socket.
 *
 * Codex's shell environment policy applies explicit values after constructing
 * the snapshot. For direct Codex launches, pin Agentbox's PATH and isolated
 * Docker endpoint there so the Bazel shim remains transparent to the agent.
 * User arguments retain their original order after these launcher-owned global
 * configuration overrides.
 */
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export type CodexCompatibility = {
  command: readonly string[];
  environment: Record<string, string>;
};

function codexConfigString(key: string, value: string): string {
  // JSON string syntax is also valid TOML basic-string syntax and safely keeps
  // spaces or punctuation in PATH from becoming Codex configuration syntax.
  return `${key}=${JSON.stringify(value)}`;
}

function installZshStartupFiles(directory: string): void {
  for (const name of [".zshenv", ".zprofile", ".zshrc", ".zlogin"]) {
    // Codex builds its shell snapshot by starting the user's shell. Preserve
    // each normal startup file, then restore Agentbox's shim to the front after
    // tool managers in that file have changed PATH. ZDOTDIR points zsh here;
    // the explicit HOME path avoids recursively sourcing this wrapper.
    writeFileSync(
      join(directory, name),
      [
        `if [[ -r "$HOME/${name}" ]]; then`,
        `  source "$HOME/${name}"`,
        "fi",
        `export PATH=${JSON.stringify(directory)}:"$PATH"`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
  }
}

export function prepareCodexCompatibility(
  command: readonly string[],
  agentboxPath: string | undefined,
  dockerHost: string | undefined,
  shimDirectory: string | undefined,
): CodexCompatibility {
  const executable = command[0];
  if (
    !executable ||
    basename(executable) !== "codex" ||
    !agentboxPath ||
    !dockerHost ||
    !shimDirectory
  ) {
    return { command, environment: {} };
  }

  installZshStartupFiles(shimDirectory);
  return {
    command: [
      executable,
      "-c",
      codexConfigString("shell_environment_policy.set.PATH", agentboxPath),
      "-c",
      codexConfigString("shell_environment_policy.set.DOCKER_HOST", dockerHost),
      ...command.slice(1),
    ],
    // Interactive Codex builds a shell snapshot by sourcing the user's startup
    // files after applying shell_environment_policy.set. The wrapper startup
    // files above reassert the shim after mise/asdf/etc. reorder PATH.
    environment: { ZDOTDIR: shimDirectory },
  };
}
