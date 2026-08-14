import assert from "node:assert/strict";
import {
  constants,
  accessSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  allowMacOSVirtualization,
  LimaDockerRelay,
  limaBackendLayout,
  limaStartCommand,
} from "../dist/lima-backend.js";

test("new Lima backends disable host mounts", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-lima-test-"));
  try {
    const layout = limaBackendLayout(root);
    assert.deepEqual(limaStartCommand("/usr/local/bin/limactl", layout), [
      "/usr/local/bin/limactl",
      "start",
      "--foreground",
      "--tty=false",
      "--name",
      "agentbox-docker",
      "--mount-none",
      "template:docker",
    ]);

    mkdirSync(join(layout.limaHome, "agentbox-docker"), { recursive: true });
    writeFileSync(join(layout.limaHome, "agentbox-docker", "lima.yaml"), "");
    assert.deepEqual(limaStartCommand("/usr/local/bin/limactl", layout), [
      "/usr/local/bin/limactl",
      "start",
      "--foreground",
      "--tty=false",
      "agentbox-docker",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS virtualization permissions extend only SRT's generated profile", () => {
  const wrapped = "before '; Essential permissions\\nafter'";
  const result = allowMacOSVirtualization(wrapped);

  assert.match(result, /xpc-service-name/);
  assert.match(result, /com\.apple\.Virtualization\.VirtualMachine/);
  assert.match(result, /kern\.hv_support/);
  assert.doesNotMatch(result, /\(allow mach-lookup\)\n/);
  assert.equal(result.startsWith("before '"), true);
  assert.equal(result.endsWith("; Essential permissions\\nafter'"), true);
  assert.throws(
    () => allowMacOSVirtualization("not an SRT wrapper"),
    /unrecognized macOS sandbox profile/,
  );
});

test("the Lima Docker bridge is byte-transparent HTTP transport", async (t) => {
  let socketTemp = tmpdir();
  try {
    accessSync("/tmp/claude", constants.W_OK);
    socketTemp = "/tmp/claude";
  } catch {
    // Outside agentbox, the platform temp directory is the portable default.
  }
  const root = mkdtempSync(join(socketTemp, "agentbox-lima-test-"));
  const socketPath = join(root, "docker.sock");
  const backend = createHttpServer((_request, response) => response.end("OK"));
  try {
    await new Promise((resolve, reject) => {
      backend.once("error", reject);
      backend.listen(socketPath, resolve);
    });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    if (error?.code === "EPERM") {
      t.skip("the outer test sandbox blocks Unix-socket listeners");
      return;
    }
    throw error;
  }

  const relay = new LimaDockerRelay(socketPath);
  try {
    const port = await relay.start();
    const result = await new Promise((resolve, reject) => {
      const request = httpRequest(
        { hostname: "127.0.0.1", port, path: "/_ping" },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.once("end", () =>
            resolve({
              status: response.statusCode,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      request.once("error", reject);
      request.end();
    });
    assert.deepEqual(result, { status: 200, body: "OK" });
  } finally {
    await relay.close();
    await new Promise((resolve) => backend.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
