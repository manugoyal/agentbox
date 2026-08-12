import { spawn, type SpawnOptions } from "node:child_process";
import { constants as osConstants } from "node:os";

function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (osConstants.signals[signal] ?? 1);
}

/** Spawn one exact argv, forward termination signals, and return its exit code. */
export function runChild(
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
): Promise<number> {
  const child = spawn(executable, args, { ...options, shell: false });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const handler = () => child.kill(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  return new Promise<number>((resolvePromise, reject) => {
    const removeHandlers = () => {
      for (const [name, handler] of handlers) process.off(name, handler);
    };
    child.once("error", (error) => {
      removeHandlers();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      removeHandlers();
      resolvePromise(signal ? signalExitCode(signal) : (code ?? 1));
    });
  });
}
