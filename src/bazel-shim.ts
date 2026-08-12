#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { basename, dirname, join } from "node:path";

type ShimConfig = {
  bazelExecutable: string;
  gitExecutable?: string;
  outputUserRoot: string;
};

// Keep the temporary shim self-contained. It is copied out of dist/ at runtime,
// so importing another package-relative module would make the copy depend on
// the installed directory layout. This is the one small process helper it needs.
function runCommand(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  const child = spawn(executable, args, {
    env: environment,
    shell: false,
    stdio: "inherit",
  });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const handler = () => child.kill(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  return new Promise<number>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      for (const [name, handler] of handlers) process.off(name, handler);
      resolvePromise(
        signal ? 128 + (osConstants.signals[signal] ?? 1) : (code ?? 1),
      );
    });
  });
}

function loadConfig(): ShimConfig {
  const path = join(dirname(process.argv[1] ?? ""), "config.json");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("invalid agentbox Bazel shim config");
  }
  const values = parsed as Partial<ShimConfig>;
  for (const name of ["bazelExecutable", "outputUserRoot"] as const) {
    if (typeof values[name] !== "string" || !values[name]) {
      throw new Error(`invalid agentbox Bazel shim config: ${name}`);
    }
  }
  if (
    values.gitExecutable !== undefined &&
    (typeof values.gitExecutable !== "string" || !values.gitExecutable)
  ) {
    throw new Error("invalid agentbox Bazel shim config: gitExecutable");
  }
  return values as ShimConfig;
}

async function main(): Promise<number> {
  const config = loadConfig();
  const userArguments = process.argv.slice(2);
  const shimName = basename(process.argv[1] ?? "");

  if (shimName === "git" || shimName === "git.mjs") {
    if (!config.gitExecutable) {
      throw new Error("agentbox could not resolve the real Git executable");
    }
    return runCommand(
      config.gitExecutable,
      ["-c", "http.proxyAuthMethod=basic", ...userArguments],
      process.env,
    );
  }

  return runCommand(
    config.bazelExecutable,
    [
      `--output_user_root=${config.outputUserRoot}`,
      "--batch",
      "--host_jvm_args=-Djava.net.preferIPv4Stack=true",
      ...userArguments,
    ],
    process.env,
  );
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
