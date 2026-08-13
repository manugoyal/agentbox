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

  // Some npm lifecycle installers ignore the standard proxy variables and
  // consult only npm_config_* (Supabase's postinstall is one example). SRT
  // injects its authenticated localhost proxy after agentbox constructs the
  // child environment, so mirror it here, inside the sandbox. Preserve an
  // explicit npm proxy supplied by the user or config.
  process.env.npm_config_https_proxy ??= process.env.HTTPS_PROXY;
  process.env.npm_config_http_proxy ??= process.env.HTTP_PROXY;
  process.env.npm_config_proxy ??=
    process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;

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
