import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";

import { fail } from "./errors.js";

export type EnvironmentOverlay = Record<string, string | null>;

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function findExecutable(
  name: string,
  pathValue = process.env.PATH ?? "",
): string | undefined {
  const candidates =
    isAbsolute(name) || name.includes("/")
      ? [name]
      : pathValue.split(delimiter).map((directory) => join(directory, name));

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue through PATH.
    }
  }
  return undefined;
}

export function overlayEnvironment(
  base: NodeJS.ProcessEnv,
  overlay: EnvironmentOverlay,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...base };
  for (const [name, value] of Object.entries(overlay)) {
    if (value === null) delete result[name];
    else result[name] = value;
  }
  return result;
}

export function runChecked(
  argv: readonly string[],
  overlay?: EnvironmentOverlay,
): string {
  const executable = argv[0];
  if (!executable) fail("internal error: attempted to run an empty command");

  const result = spawnSync(executable, argv.slice(1), {
    encoding: "utf8",
    env: overlay ? overlayEnvironment(process.env, overlay) : process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error(result.error.message);
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || "command failed").trim(),
    );
  }
  return result.stdout;
}

export function ensureDirectory(path: string): void {
  try {
    mkdirSync(path, { recursive: true });
  } catch (error) {
    console.error(`agentbox: could not create ${path}: ${String(error)}`);
  }
}

export function isUsableDirectory(path: string | undefined): path is string {
  if (!path || !existsSync(path)) return false;
  try {
    return (
      statSync(path).isDirectory() &&
      accessSync(path, constants.W_OK) === undefined
    );
  } catch {
    return false;
  }
}

/** Replace the process environment with the exact child allowlist. */
export function replaceProcessEnvironment(
  environment: NodeJS.ProcessEnv,
): void {
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, environment);
}
