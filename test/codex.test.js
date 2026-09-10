import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareCodexCompatibility } from "../dist/codex.js";

test("Codex tool commands retain Agentbox's Bazel and Docker environment", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentbox-codex-test-"));
  const command = ["codex", "--yolo", "resume", "session-id"];
  try {
    const compatibility = prepareCodexCompatibility(
      command,
      `${directory}:/usr/bin:/bin`,
      "tcp://127.0.0.1:51481",
      directory,
    );
    assert.deepEqual(compatibility, {
      command: [
        "codex",
        "-c",
        `shell_environment_policy.set.PATH=${JSON.stringify(`${directory}:/usr/bin:/bin`)}`,
        "-c",
        'shell_environment_policy.set.DOCKER_HOST="tcp://127.0.0.1:51481"',
        "--yolo",
        "resume",
        "session-id",
      ],
      environment: { ZDOTDIR: directory },
    });
    assert.deepEqual(command, ["codex", "--yolo", "resume", "session-id"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Codex compatibility is scoped to a complete Docker-backed Bazel setup", () => {
  const bash = ["bash", "-lc", "bazel test //..."];
  assert.deepEqual(
    prepareCodexCompatibility(
      bash,
      "/tmp/agentbox-bazel:/bin",
      "tcp://127.0.0.1:51481",
      "/tmp/agentbox-bazel",
    ),
    { command: bash, environment: {} },
  );

  const codex = ["/opt/bin/codex", "resume", "session-id"];
  assert.deepEqual(
    prepareCodexCompatibility(
      codex,
      undefined,
      "tcp://127.0.0.1:51481",
      "/tmp/agentbox-bazel",
    ),
    { command: codex, environment: {} },
  );
  assert.deepEqual(
    prepareCodexCompatibility(
      codex,
      "/tmp/agentbox-bazel:/bin",
      undefined,
      "/tmp/agentbox-bazel",
    ),
    { command: codex, environment: {} },
  );
});

test(
  "Codex zsh startup compatibility restores the Bazel shim after mise-like PATH changes",
  { skip: process.platform !== "darwin" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "agentbox-codex-zsh-test-"));
    const home = join(root, "home");
    const shim = join(root, "agentbox-bazel-shim");
    const toolManager = join(root, "tool-manager");
    try {
      mkdirSync(home);
      mkdirSync(shim);
      mkdirSync(toolManager);
      writeFileSync(join(home, ".zshrc"), `export PATH=${toolManager}:$PATH\n`);
      for (const directory of [shim, toolManager]) {
        const bazel = join(directory, "bazel");
        writeFileSync(bazel, "#!/bin/sh\nexit 0\n");
        chmodSync(bazel, 0o700);
      }

      const compatibility = prepareCodexCompatibility(
        ["codex"],
        `${shim}:/usr/bin:/bin`,
        "tcp://127.0.0.1:51481",
        shim,
      );
      const result = spawnSync("/bin/zsh", ["-lic", "command -v bazel"], {
        encoding: "utf8",
        env: {
          HOME: home,
          PATH: "/usr/bin:/bin",
          ...compatibility.environment,
        },
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), join(shim, "bazel"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
