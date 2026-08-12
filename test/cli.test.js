import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { parseArguments } from "../dist/cli.js";
import { AgentboxConfig } from "../dist/config.js";
import { AgentboxError } from "../dist/errors.js";
import { EMBEDDED_POLICY } from "../dist/policy.js";

test("parses launcher options and leaves the complete child command alone", () => {
  const parsed = parseArguments([
    "-y",
    "--secret",
    "TOKEN=op://Vault/Item/value",
    "--",
    "codex",
    "--yolo",
    "a value with spaces",
  ]);

  assert.equal(parsed.yes, true);
  assert.deepEqual(parsed.secrets, ["TOKEN=op://Vault/Item/value"]);
  assert.deepEqual(parsed.command, ["codex", "--yolo", "a value with spaces"]);
});

test("requires child options to appear after the separator", () => {
  assert.throws(
    () => parseArguments(["--yolo"]),
    (error) =>
      error instanceof AgentboxError &&
      error.message === "unknown option --yolo; put child options after --",
  );
});

test("the sandbox-side runner preserves argv without shell parsing", () => {
  const expected = ["spaces here", "single'quote", "!bang", ""];
  const command = [
    process.execPath,
    "-e",
    "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
    ...expected,
  ];
  const result = spawnSync(process.execPath, ["dist/child-runner.js"], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENTBOX_INTERNAL_COMMAND: Buffer.from(JSON.stringify(command)).toString(
        "base64url",
      ),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
});

test("config rejects unknown keys and accepts string tables", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentbox-test-"));
  try {
    const valid = join(directory, "valid.toml");
    writeFileSync(valid, '[env]\nSERVICE_ORG = "example"\n');
    assert.equal(new AgentboxConfig(valid, true).env.SERVICE_ORG, "example");

    const invalid = join(directory, "invalid.toml");
    writeFileSync(invalid, 'aws_proflie = "typo"\n');
    assert.throws(() => new AgentboxConfig(invalid, true), AgentboxError);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the embedded network policy has no permissive fallback", () => {
  assert.equal(EMBEDDED_POLICY.network.strictAllowlist, true);
  assert.equal(EMBEDDED_POLICY.network.allowedDomains.includes("*"), false);
  assert.equal(EMBEDDED_POLICY.network.deniedDomains.length, 0);
});
