import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { parseArguments } from "../dist/cli.js";
import { AgentboxConfig } from "../dist/config.js";
import { AgentboxError } from "../dist/errors.js";
import { allowUnrestrictedMacOSIpEgress } from "../dist/seatbelt.js";

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

test(
  "unrestricted macOS IP egress preserves Unix-socket restrictions",
  { skip: process.platform !== "darwin" },
  () => {
    const profile = [
      "(version 1)",
      "(deny default)",
      "; Network",
      '(allow network-outbound (remote unix-socket (subpath "/tmp/claude")))',
    ].join("\n");
    const argv = [
      "/usr/bin/env",
      "/usr/bin/sandbox-exec",
      "-p",
      profile,
      "/bin/bash",
    ];

    const result = allowUnrestrictedMacOSIpEgress(argv);
    assert.match(result[3], /\(allow network-outbound \(remote ip "\*:\*"\)\)/);
    assert.match(result[3], /remote unix-socket/);
    assert.doesNotMatch(result[3], /\(allow network\*\)/);
    assert.equal(argv[3], profile);

    const wrapped = [
      "/bin/bash",
      "-c",
      `'/usr/bin/sandbox-exec' '-p' '${profile}' '/bin/bash' '-c' 'true'`,
    ];
    const wrappedResult = allowUnrestrictedMacOSIpEgress(wrapped);
    assert.match(
      wrappedResult[2],
      /\(allow network-outbound \(remote ip "\*:\*"\)\)/,
    );
  },
);

test("parses Docker backend lifecycle actions separately from commands", () => {
  assert.equal(parseArguments(["--docker-status"]).dockerAction, "status");
  assert.throws(
    () => parseArguments(["--docker-start", "--docker-stop"]),
    (error) =>
      error instanceof AgentboxError &&
      error.message === "only one Docker backend action may be specified",
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

test("the sandbox-side runner exposes SRT's proxy to npm installers", () => {
  const command = [
    process.execPath,
    "-e",
    "process.stdout.write(JSON.stringify({ https: process.env.npm_config_https_proxy, http: process.env.npm_config_http_proxy, proxy: process.env.npm_config_proxy }))",
  ];
  const environment = {
    ...process.env,
    HTTPS_PROXY: "http://localhost:41001",
    HTTP_PROXY: "http://localhost:41002",
    AGENTBOX_INTERNAL_COMMAND: Buffer.from(JSON.stringify(command)).toString(
      "base64url",
    ),
  };
  delete environment.npm_config_https_proxy;
  delete environment.npm_config_http_proxy;
  environment.npm_config_proxy = "http://explicit.example:8080";

  const result = spawnSync(process.execPath, ["dist/child-runner.js"], {
    encoding: "utf8",
    env: environment,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    https: "http://localhost:41001",
    http: "http://localhost:41002",
    proxy: "http://explicit.example:8080",
  });
});

test("the sandbox-side runner performs marked Bazel cleanup", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentbox-bazel-cleanup-test-"));
  try {
    const marker = join(directory, "used");
    const resultPath = join(directory, "cleanup-result");
    writeFileSync(marker, "");
    const command = [process.execPath, "-e", "process.exit(7)"];
    const cleanup = {
      command: [
        process.execPath,
        "-e",
        'require("node:fs").writeFileSync(process.argv[1], "done")',
        resultPath,
      ],
      marker,
    };
    const result = spawnSync(process.execPath, ["dist/child-runner.js"], {
      encoding: "utf8",
      env: {
        ...process.env,
        AGENTBOX_INTERNAL_COMMAND: Buffer.from(
          JSON.stringify(command),
        ).toString("base64url"),
        AGENTBOX_INTERNAL_BAZEL_CLEANUP: Buffer.from(
          JSON.stringify(cleanup),
        ).toString("base64url"),
      },
    });

    assert.equal(result.status, 7, result.stderr);
    assert.equal(readFileSync(resultPath, "utf8"), "done");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
