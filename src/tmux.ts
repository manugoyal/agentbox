import { readFileSync } from "node:fs";
import type { Config } from "./config.js";
import type { Connection } from "./lima.js";
import { runSession } from "./session.js";
import { fail } from "./system.js";

export function refreshTmux(
  connection: Connection,
  config: Config["run"],
  session: string,
): Promise<number> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(session))
    fail(
      "tmux session name must contain only letters, numbers, underscores and hyphens",
    );
  const runner = readFileSync(
    new URL("../vm/tmux.py", import.meta.url),
    "utf8",
  );
  return runSession(
    connection,
    config,
    ["/usr/bin/python3", "-c", runner, session],
    true,
  );
}
