import assert from "node:assert/strict";
import {
  mkdirSync,
  linkSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArguments } from "../dist/cli.js";
import { AgentboxConfig } from "../dist/config.js";
import { AgentboxError } from "../dist/errors.js";
import { loadPolicy } from "../dist/policy.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "agentbox-policy-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspace = join(directory, "workspace");
  mkdirSync(workspace);
  return { directory, workspace };
}

test("parses launcher options and leaves the complete child command alone", () => {
  const parsed = parseArguments([
    "-y",
    "--network=host",
    "--secret",
    "TOKEN=op://Vault/Item/value",
    "--",
    "agent",
    "--yolo",
    "a value with spaces",
  ]);
  assert.equal(parsed.yes, true);
  assert.equal(parsed.network, "host");
  assert.deepEqual(parsed.secrets, ["TOKEN=op://Vault/Item/value"]);
  assert.deepEqual(parsed.command, ["agent", "--yolo", "a value with spaces"]);
  assert.throws(
    () => parseArguments(["--network", "unexpected"]),
    /must be none or host/,
  );
  assert.throws(() => parseArguments(["--yolo"]), /put child options after --/);
  assert.throws(() => parseArguments(["--docker-start"]), /unknown option/);
});

test("config accepts explicit grants and aggregate limits, rejects mistakes and legacy policies", (t) => {
  const { directory } = fixture(t);
  const path = join(directory, "config.toml");
  writeFileSync(
    path,
    'network = "host"\n[limits]\nmemory = "2G"\ntasks = 64\ncpu = 200\n[filesystem]\nread_only = ["../docs"]\nread_write = ["../repo"]\n[env]\nSERVICE_ORG = "example"\n',
  );
  const config = new AgentboxConfig(path, true);
  assert.equal(config.network, "host");
  assert.deepEqual(config.limits, { memory: "2G", tasks: 64, cpu: 200 });
  assert.deepEqual(config.filesystem, {
    readOnly: ["../docs"],
    readWrite: ["../repo"],
  });
  assert.equal(config.env.SERVICE_ORG, "example");
  for (const source of [
    'aws_proflie = "typo"',
    'srt_settings = "old.json"',
    "[limits]\ntasks = 0",
    '[limits]\nmemory = "infinity"',
  ]) {
    writeFileSync(path, source);
    assert.throws(() => new AgentboxConfig(path, true), AgentboxError);
  }
});

test("read-only grants cannot be reopened through aliases or child write grants", (t) => {
  const { directory, workspace } = fixture(t);
  const reference = join(directory, "reference");
  mkdirSync(join(reference, "child"), { recursive: true });
  symlinkSync(reference, join(directory, "alias"));
  assert.throws(
    () =>
      loadPolicy(undefined, workspace, {
        filesystem: { readOnly: [reference], readWrite: ["../alias"] },
      }),
    /conflicts/,
  );
  assert.throws(
    () =>
      loadPolicy(undefined, workspace, {
        filesystem: {
          readOnly: [reference],
          readWrite: [join(reference, "child")],
        },
      }),
    /conflicts/,
  );
  for (const path of [
    "/proc",
    "/proc/self/root",
    "/dev",
    "/run",
    "/sys",
    "/",
  ]) {
    assert.throws(
      () =>
        loadPolicy(undefined, workspace, { filesystem: { readOnly: [path] } }),
      /cannot grant/,
    );
  }
});

test("settings are strict and explicit CLI/config overrides win", (t) => {
  const { directory, workspace } = fixture(t);
  const settings = join(directory, "settings.json");
  writeFileSync(
    settings,
    JSON.stringify({ network: "host", limits: { tasks: 24 } }),
  );
  const policy = loadPolicy(settings, workspace, {
    network: "none",
    limits: { memory: "1G" },
  });
  assert.equal(policy.network, "none");
  assert.deepEqual(policy.limits, { tasks: 24, memory: "1G" });
  writeFileSync(
    settings,
    JSON.stringify({
      enableWeakerNestedSandbox: true,
      filesystem: { allowWrite: ["/"] },
    }),
  );
  assert.throws(
    () => loadPolicy(settings, workspace),
    /Legacy SRT policies must be migrated/,
  );
});

test("NUL-containing environment values cannot inject bubblewrap arguments", async (t) => {
  const { workspace } = fixture(t);
  const { launchSandbox } = await import("../dist/linux-sandbox.js");
  await assert.rejects(
    launchSandbox(loadPolicy(undefined, workspace), ["true"], {
      INJECT: "value\0--bind\0/\0/",
    }),
    /invalid sandbox environment/,
  );
});

test("policy symlinks and hard links cannot bypass protection through aliases", (t) => {
  const { directory, workspace } = fixture(t);
  const config = join(directory, "trusted.toml");
  writeFileSync(config, "");
  const alias = join(workspace, "config.toml");
  symlinkSync(config, alias);
  assert.throws(
    () => loadPolicy(undefined, workspace, { protectedWritePaths: [alias] }),
    /would freeze the checkout/,
  );
  linkSync(config, join(workspace, "hard-link.toml"));
  assert.throws(
    () => loadPolicy(undefined, workspace, { protectedWritePaths: [config] }),
    /hard-link aliases/,
  );
});
