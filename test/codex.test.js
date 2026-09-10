import assert from "node:assert/strict";
import test from "node:test";

import { prepareCodexCompatibility } from "../dist/codex.js";

test("Codex tool commands retain Agentbox's Bazel and Docker environment", () => {
  const command = ["codex", "--yolo", "resume", "session-id"];
  assert.deepEqual(
    prepareCodexCompatibility(
      command,
      "/tmp/agentbox-bazel:/usr/bin:/bin",
      "tcp://127.0.0.1:51481",
    ),
    [
      "codex",
      "-c",
      'shell_environment_policy.set.PATH="/tmp/agentbox-bazel:/usr/bin:/bin"',
      "-c",
      'shell_environment_policy.set.DOCKER_HOST="tcp://127.0.0.1:51481"',
      "--yolo",
      "resume",
      "session-id",
    ],
  );
  assert.deepEqual(command, ["codex", "--yolo", "resume", "session-id"]);
});

test("Codex compatibility is scoped to a complete Docker-backed Bazel setup", () => {
  const bash = ["bash", "-lc", "bazel test //..."];
  assert.equal(
    prepareCodexCompatibility(
      bash,
      "/tmp/agentbox-bazel:/bin",
      "tcp://127.0.0.1:51481",
    ),
    bash,
  );

  const codex = ["/opt/bin/codex", "resume", "session-id"];
  assert.equal(
    prepareCodexCompatibility(codex, undefined, "tcp://127.0.0.1:51481"),
    codex,
  );
  assert.equal(
    prepareCodexCompatibility(codex, "/tmp/agentbox-bazel:/bin", undefined),
    codex,
  );
});
