import { accessSync, constants, statSync } from "node:fs";
import { spawn, type SpawnOptions } from "node:child_process";
import { constants as osConstants, homedir } from "node:os";
import { delimiter, join } from "node:path";

export function fail(message: string): never {
  throw new Error(message);
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function findExecutable(
  name: string,
  pathValue = process.env.PATH ?? "",
): string | undefined {
  const candidates = name.includes("/")
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

/** Run a child while forwarding terminal and termination signals. */
export function runChild(
  executable: string,
  args: readonly string[],
  options: SpawnOptions & { input?: string },
): Promise<number> {
  const { input, ...spawnOptions } = options;
  const child = spawn(executable, args, {
    ...spawnOptions,
    shell: false,
    stdio: input === undefined ? options.stdio : ["pipe", "inherit", "inherit"],
  });
  if (input !== undefined) child.stdin?.end(input);
  const handlers = (["SIGINT", "SIGTERM", "SIGHUP", "SIGWINCH"] as const).map(
    (signal) => [signal, () => child.kill(signal)] as const,
  );
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const cleanup = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve(signal ? 128 + (osConstants.signals[signal] ?? 1) : (code ?? 1));
    });
  });
}
