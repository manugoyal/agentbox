#!/usr/bin/env node

/**
 * Minimal command runner on the sandboxed side of the SRT boundary.
 *
 * SRT's wrapper accepts a shell command, so the trusted launcher carries the
 * user's argv in an internal environment value and always invokes this fixed
 * program. The runner removes those transport values and uses `spawn` without
 * a shell, preserving the exact argv without creating a command-injection path.
 * It also owns cleanup that must happen before the sandbox disappears, notably
 * shutting down a Bazel server created during the session.
 */
import { existsSync } from "node:fs";

import { runChild } from "./child-process.js";

const COMMAND_VARIABLE = "AGENTBOX_INTERNAL_COMMAND";
const BAZEL_CLEANUP_VARIABLE = "AGENTBOX_INTERNAL_BAZEL_CLEANUP";

type BazelCleanup = {
  command: string[];
  marker: string;
};

function requiredVariable(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`agentbox runner is missing ${name}`);
  return value;
}

async function main(): Promise<number> {
  const encodedCommand = requiredVariable(COMMAND_VARIABLE);
  const encodedBazelCleanup = process.env[BAZEL_CLEANUP_VARIABLE];

  // These values are launcher-to-runner transport, not part of the environment
  // contract presented to the user's command.
  delete process.env[COMMAND_VARIABLE];
  delete process.env[BAZEL_CLEANUP_VARIABLE];
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

  let bazelCleanup: BazelCleanup | undefined;
  if (encodedBazelCleanup) {
    const value: unknown = JSON.parse(
      Buffer.from(encodedBazelCleanup, "base64url").toString(),
    );
    if (
      typeof value !== "object" ||
      value === null ||
      !("command" in value) ||
      !Array.isArray(value.command) ||
      !value.command.every((argument) => typeof argument === "string") ||
      !("marker" in value) ||
      typeof value.marker !== "string"
    ) {
      throw new Error("agentbox runner received invalid Bazel cleanup state");
    }
    bazelCleanup = value as BazelCleanup;
  }

  try {
    return await runChild(executable, args, {
      env: process.env,
      stdio: "inherit",
    });
  } finally {
    if (bazelCleanup && existsSync(bazelCleanup.marker)) {
      const [cleanupExecutable, ...cleanupArguments] = bazelCleanup.command;
      if (cleanupExecutable) {
        try {
          const cleanupExitCode = await runChild(
            cleanupExecutable,
            cleanupArguments,
            {
              env: process.env,
              stdio: "ignore",
            },
          );
          if (cleanupExitCode !== 0) {
            console.error(
              `agentbox: warning: Bazel server shutdown exited ${cleanupExitCode}`,
            );
          }
        } catch (error) {
          console.error(
            `agentbox: warning: could not shut down Bazel server: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
  }
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
