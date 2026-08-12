#!/usr/bin/env node

import { runChild } from "./child-process.js";

const COMMAND_VARIABLE = "AGENTBOX_INTERNAL_COMMAND";

function requiredVariable(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`agentbox runner is missing ${name}`);
  return value;
}

async function main(): Promise<number> {
  const encodedCommand = requiredVariable(COMMAND_VARIABLE);

  // These values are launcher-to-runner transport, not part of the environment
  // contract presented to the user's command.
  delete process.env[COMMAND_VARIABLE];
  delete process.env.AGENTBOX_INTERNAL_NODE;
  delete process.env.AGENTBOX_INTERNAL_RUNNER;

  const decoded: unknown = JSON.parse(
    Buffer.from(encodedCommand, "base64url").toString(),
  );
  if (
    !Array.isArray(decoded) ||
    !decoded.every((value) => typeof value === "string")
  ) {
    throw new Error("agentbox runner received an invalid command");
  }
  const [executable, ...args] = decoded;
  if (!executable) throw new Error("agentbox runner received an empty command");

  return runChild(executable, args, {
    env: process.env,
    stdio: "inherit",
  });
}

main().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    console.error(
      `agentbox: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  },
);
