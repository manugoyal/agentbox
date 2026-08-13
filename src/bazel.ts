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
  close(): void;
};

const NO_BAZEL_COMPATIBILITY: BazelCompatibility = {
  environment: {},
  close() {},
};

/**
 * Put a small Bazel argv shim first on PATH on macOS.
 *
 * Why batch mode is necessary here:
 *
 * - Normal Bazel is a native client connected over localhost gRPC to a
 *   persistent Java server. SRT's macOS Seatbelt profile intentionally lets a
 *   process inspect and signal only processes in the same sandbox.
 * - A server started outside agentbox therefore cannot be verified by the
 *   sandboxed client. It would also be unsafe: that server would execute build
 *   actions outside the filesystem sandbox.
 * - A server started by one agentbox invocation is not reusable by another
 *   invocation either. Each has a distinct Seatbelt sandbox and SRT proxy, so
 *   sharing a persistent server introduces process-verification failures,
 *   output-base locking, dead proxy endpoints, and ambiguous ownership of
 *   server shutdown.
 *
 * `--batch` avoids the client/server boundary. Bazel starts one Java process
 * for the command and waits for it to exit. Because the native launcher itself
 * runs inside SRT, that Java process and all build actions inherit the same OS
 * sandbox. Simultaneous batch invocations using one output base retain Bazel's
 * normal queueing semantics instead of trying to own one persistent server.
 *
 * Batch mode still uses the on-disk output tree, action cache, repository
 * cache, and any project-configured disk/remote cache. A stable agentbox-only
 * `output_user_root` preserves that state across launches while ensuring a
 * batch invocation never finds or kills a host Bazel server. What batch mode
 * deliberately gives up is the Java server's in-memory loading and analysis
 * cache; that is the performance tradeoff for this much simpler lifecycle.
 *
 * One networking detail remains. SRT's macOS proxy listens on native IPv4.
 * Modern Java may represent a connection to 127.0.0.1 as IPv4-mapped IPv6,
 * which Seatbelt's safe localhost rule does not match. SRT normally injects
 * `-Djava.net.preferIPv4Stack=true` via JAVA_TOOL_OPTIONS, but Bazel strips that
 * variable while launching Java. Passing the same property as a Bazel startup
 * option makes the batch JVM connect to SRT's ordinary authenticated proxy over
 * native IPv4. No custom relay or network-policy exception is needed.
 *
 * Bazel's built-in git_repository rule creates one more proxy wrinkle. SRT
 * puts `http.proxyAuthMethod=basic` in GIT_CONFIG_PARAMETERS so Git pre-sends
 * credentials to its authenticated localhost proxy. Bazel deliberately clears
 * that variable (along with the other repository-local GIT_* variables) before
 * each repository fetch. Apple Git then attempts a proxy authentication
 * negotiation that ends with the misleading `Proxy CONNECT aborted` error.
 *
 * GIT_CONFIG_SYSTEM is not among the variables Bazel clears. The shim points it
 * at a temporary config containing the same setting, scoped to this one batch
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
      })}\n`,
      { mode: 0o600 },
    );

    return {
      environment: { PATH: `${shimDirectory}${delimiter}${basePath}` },
      close() {
        rmSync(shimDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(shimDirectory, { recursive: true, force: true });
    throw error;
  }
}
