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

/**
 * Put a small Bazel argv shim first on PATH on macOS.
 *
 * Why the server is scoped to one agentbox launch:
 *
 * - Normal Bazel is a native client connected over localhost gRPC to a
 *   persistent Java server. SRT's macOS Seatbelt profile intentionally lets a
 *   process inspect and signal only processes in the same sandbox.
 * - A server started outside agentbox therefore cannot be verified by the
 *   sandboxed client. It would also be unsafe: that server would execute build
 *   actions outside the filesystem sandbox.
 * - A server started by one agentbox invocation is not reusable by another
 *   invocation either. Each has a distinct Seatbelt sandbox, so sharing a
 *   persistent server introduces process-verification failures and, more
 *   importantly, lets a later sandbox execute through an earlier one.
 *
 * The shim therefore starts a normal Bazel server inside the current Seatbelt
 * sandbox and reuses it for every Bazel command issued by the sandboxed child.
 * The sandbox-side runner shuts it down before that child exits. A short Bazel
 * idle timeout is only a fallback for an unclean agentbox termination.
 *
 * A stable agentbox-only `output_user_root` preserves the on-disk output tree,
 * action cache, repository cache, and any project-configured disk/remote cache
 * across launches while ensuring agentbox never finds or controls the user's
 * host Bazel server. Only the in-memory server state is launch-scoped.
 *
 * One networking detail remains. SRT's macOS proxy listens on native IPv4.
 * Modern Java may represent a connection to 127.0.0.1 as IPv4-mapped IPv6,
 * which Seatbelt's safe localhost rule does not match. SRT normally injects
 * `-Djava.net.preferIPv4Stack=true` via JAVA_TOOL_OPTIONS, but Bazel strips that
 * variable while launching Java. Passing the same property as a Bazel startup
 * option makes the server JVM connect to SRT's ordinary authenticated proxy over
 * native IPv4. No custom relay or network-policy exception is needed.
 *
 * Bazel also constructs a fresh environment for test actions rather than
 * passing through arbitrary launcher variables. When agentbox has made its
 * isolated Docker backend available, the shim explicitly carries DOCKER_HOST
 * into tests. It points at an agentbox-owned loopback listener; the host Docker
 * socket itself is never exposed to the Bazel process or test action.
 *
 * Bazel's built-in git_repository rule creates one more proxy wrinkle. SRT
 * puts `http.proxyAuthMethod=basic` in GIT_CONFIG_PARAMETERS so Git pre-sends
 * credentials to its authenticated localhost proxy. Bazel deliberately clears
 * that variable (along with the other repository-local GIT_* variables) before
 * each repository fetch. Apple Git then attempts a proxy authentication
 * negotiation that ends with the misleading `Proxy CONNECT aborted` error.
 *
 * GIT_CONFIG_SYSTEM is not among the variables Bazel clears. The shim points it
 * at a temporary config containing the same setting, scoped to this one agentbox
 * invocation. The config includes Git's normal /etc/gitconfig first and does
 * not replace the user's global or repository config. This is independent of
 * PATH ordering and requires no interception of the Git executable itself.
 */
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
