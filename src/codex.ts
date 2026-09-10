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
import { basename } from "node:path";

function codexConfigString(key: string, value: string): string {
  // JSON string syntax is also valid TOML basic-string syntax and safely keeps
  // spaces or punctuation in PATH from becoming Codex configuration syntax.
  return `${key}=${JSON.stringify(value)}`;
}

export function prepareCodexCompatibility(
  command: readonly string[],
  agentboxPath: string | undefined,
  dockerHost: string | undefined,
): readonly string[] {
  const executable = command[0];
  if (
    !executable ||
    basename(executable) !== "codex" ||
    !agentboxPath ||
    !dockerHost
  ) {
    return command;
  }

  return [
    executable,
    "-c",
    codexConfigString("shell_environment_policy.set.PATH", agentboxPath),
    "-c",
    codexConfigString("shell_environment_policy.set.DOCKER_HOST", dockerHost),
    ...command.slice(1),
  ];
}
