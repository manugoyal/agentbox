import { readFileSync } from "node:fs";
import type { Config } from "./config.js";
import { environmentSchema } from "./config.js";
import { exportAwsCredentials, readSecrets } from "./credentials.js";
import type { Connection } from "./lima.js";
import { fail } from "./system.js";

export async function runSession(
  connection: Connection,
  config: Config["run"],
  argv: string[],
  appendEnvironmentNames = false,
): Promise<number> {
  if (!argv[0] || argv.some((arg) => arg.includes("\0")))
    fail("a valid command is required");
  const env: Record<string, string> = {};
  const refreshNames = new Set<string>();
  for (const key of ["TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE"])
    if (process.env[key] !== undefined) env[key] = process.env[key]!;
  Object.assign(env, config.env);
  for (const name of Object.keys(config.env)) refreshNames.add(name);
  if (config.aws_profile) {
    const credentials = exportAwsCredentials(
      config.aws_profile,
      config.aws_region,
    );
    Object.assign(env, credentials.environment);
    for (const name of Object.keys(credentials.environment))
      refreshNames.add(name);
    console.error(`agentbox: AWS credentials expire ${credentials.expiration}`);
  }
  const secrets = readSecrets(config.secrets);
  Object.assign(env, secrets);
  for (const name of Object.keys(secrets)) refreshNames.add(name);
  environmentSchema.parse(env);
  const requestArgv = appendEnvironmentNames
    ? [...argv, JSON.stringify([...refreshNames].sort())]
    : argv;
  const payload = JSON.stringify({ argv: requestArgv, env });
  if (Buffer.byteLength(payload) > 1024 ** 2)
    fail("session request exceeds 1 MiB");
  const runner = readFileSync(
    new URL("../vm/session.py", import.meta.url),
    "utf8",
  );
  const command = ["/usr/bin/python3", "-c", runner];
  const ticket = connection.capture([...command, "stage"], payload);
  if (!/^[a-f0-9]{32}$/.test(ticket))
    fail("VM returned an invalid session ticket");
  try {
    return await connection.run([...command, "run", ticket]);
  } finally {
    try {
      connection.capture([...command, "discard", ticket]);
    } catch {
      console.error(
        "agentbox: session cleanup could not reach the VM; an unclaimed handoff expires after five minutes and is cleared on the next launch or reboot",
      );
    }
  }
}
