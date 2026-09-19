import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { configSchema, loadConfig } from "../dist/config.js";
import { generateVM, assertBoundary } from "../dist/lima.js";
import { parseArguments } from "../dist/cli.js";

const defaults = configSchema.parse({});
test("machine shares become concrete resources and explicit localhost ports", () => {
  const config = { ...defaults.vm, ports: [3000, 8000, 3000] };
  const doc = parse(
    generateVM(config, {
      cpus: 16,
      memoryBytes: 64 * 1024 ** 3,
      platform: "darwin",
    }),
  );
  assert.equal(doc.cpus, 12);
  assert.equal(doc.memory, "49152MiB");
  assert.equal(doc.vmType, "vz");
  assert.deepEqual(doc.mounts, []);
  assert.equal(doc.ssh.forwardAgent, false);
  assert.equal(doc.portForwards.length, 3);
  assert.deepEqual(doc.portForwards[0], {
    guestPort: 3000,
    hostPort: 3000,
    guestIP: "127.0.0.1",
    hostIP: "127.0.0.1",
    proto: "tcp",
    static: true,
  });
  assert.equal(doc.portForwards[2].ignore, true);
  assert.throws(
    () => generateVM(config, { cpus: 0, memoryBytes: 8e9, platform: "linux" }),
    /invalid host/,
  );
  assert.throws(
    () =>
      generateVM(config, {
        cpus: 1,
        memoryBytes: 512 * 1024 ** 2,
        platform: "linux",
      }),
    /less than/,
  );
});

test("unsafe VM configuration cannot be reused for a credential session", () => {
  const original = parse(generateVM(defaults.vm));
  for (const mutate of [
    (d) => d.mounts.push({ location: "~" }),
    (d) => d.copyToHost.push({ guest: "/tmp/file", host: "~/.ssh/config" }),
    (d) => (d.ssh.forwardAgent = true),
    (d) => (d.ssh.forwardX11 = true),
    (d) => (d.base = "template:default"),
    (d) => (d.propagateProxyEnv = true),
    (d) => (d.portForwards = []),
    (d) =>
      d.portForwards.unshift({
        guestSocket: "/run/docker.sock",
        hostSocket: "/tmp/docker.sock",
      }),
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.throws(() => assertBoundary(changed));
  }
});

test("configuration is strict and command argv after -- is untouched", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-config-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "config.toml");
  writeFileSync(file, "[vm]\ncpu_percent = 101\n");
  assert.throws(() => loadConfig(file, true));
  writeFileSync(file, '[filesystem]\nread_write = ["~"]\n');
  assert.throws(() => loadConfig(file, true));
  assert.throws(() => loadConfig(join(root, "absent"), true));
  const args = parseArguments([
    "run",
    "-s",
    "TOKEN=op://V/I/f",
    "--",
    "bash",
    "-c",
    "printf '%s' '$x'",
    "--vm",
    "child-option",
  ]);
  assert.deepEqual(args.command, [
    "bash",
    "-c",
    "printf '%s' '$x'",
    "--vm",
    "child-option",
  ]);
});
