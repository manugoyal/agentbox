/**
 * Bazel compatibility for macOS sandbox launches.
 *
 * Bazel normally delegates work to a persistent Java server. Reusing a server
 * started on the host would let build actions run outside Agentbox; reusing one
 * from an earlier launch would cross two different Seatbelt sandboxes. Agentbox
 * instead puts a small shim first on PATH. The shim selects an Agentbox-only
 * output root, starts the server inside the current sandbox, and lets commands
 * reuse it for the life of that launch. The sandbox-side runner shuts the server
 * down at exit, with Bazel's idle timeout as crash recovery. On-disk build state
 * remains reusable across launches.
 *
 * The same shim handles two narrower compatibility gaps: Bazel filters the
 * environment seen by repository and test actions, so Agentbox explicitly
 * preserves Git's proxy behavior and the isolated Docker endpoint where needed.
 *
 * Caveats: this applies only on macOS and only when `bazel` is resolved through
 * PATH; an explicitly invoked Bazel binary bypasses the shim. Servers are not
 * shared across Agentbox launches, and concurrent launches in the same checkout
 * may contend for the same output base.
 */
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { findExecutable } from "./system.js";

export type BazelCompatibility = {
  environment: Record<string, string>;
  cleanup:
    | {
        command: readonly string[];
        marker: string;
      }
    | undefined;
  close(): void;
};

const NO_BAZEL_COMPATIBILITY: BazelCompatibility = {
  environment: {},
  cleanup: undefined,
  close() {},
};

/** Install the launch-scoped Bazel shim and describe its eventual cleanup. */
export function prepareBazelCompatibility(
  basePath: string,
): BazelCompatibility {
  if (process.platform !== "darwin") return NO_BAZEL_COMPATIBILITY;

  const bazel = findExecutable("bazel", basePath);
  if (!bazel) return NO_BAZEL_COMPATIBILITY;

  const shimDirectory = mkdtempSync(join(tmpdir(), "agentbox-bazel-"));
  try {
    const shimPath = join(shimDirectory, "bazel");
    const shimModulePath = join(shimDirectory, "bazel.mjs");
    copyFileSync(
      fileURLToPath(new URL("./bazel-shim.js", import.meta.url)),
      shimModulePath,
    );
    chmodSync(shimModulePath, 0o700);
    symlinkSync("bazel.mjs", shimPath);

    const gitConfigSystem = join(shimDirectory, "gitconfig");
    const usedMarker = join(shimDirectory, "bazel-used");
    writeFileSync(
      gitConfigSystem,
      "[include]\n\tpath = /etc/gitconfig\n[http]\n\tproxyAuthMethod = basic\n",
      { mode: 0o600 },
    );

    writeFileSync(
      join(shimDirectory, "config.json"),
      `${JSON.stringify({
        bazelExecutable: bazel,
        gitConfigSystem,
        outputUserRoot: join(homedir(), ".cache", "agentbox", "bazel"),
        usedMarker,
      })}\n`,
      { mode: 0o600 },
    );

    return {
      environment: { PATH: `${shimDirectory}${delimiter}${basePath}` },
      cleanup: {
        command: [shimPath, "shutdown"],
        marker: usedMarker,
      },
      close() {
        rmSync(shimDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(shimDirectory, { recursive: true, force: true });
    throw error;
  }
}
