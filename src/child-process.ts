import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { constants as osConstants } from "node:os";
import type { Writable } from "node:stream";

function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (osConstants.signals[signal] ?? 1);
}

/** Spawn one exact argv, forward termination signals, and return its exit code. */
export function runChild(
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
  input?: Buffer,
  setup?: (child: ChildProcess) => Promise<void>,
): Promise<number> {
  const child = spawn(executable, args, { ...options, shell: false });
  if (input) {
    const pipe = child.stdio[3] as Writable;
    // Early setup failures can close the pipe before all arguments are read.
    pipe.on("error", () => {});
    pipe.end(input);
  }
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
    if (setup)
      setup(child).catch((error) => {
        child.kill("SIGKILL");
        removeHandlers();
        reject(error);
      });
  });
}
