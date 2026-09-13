import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

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
