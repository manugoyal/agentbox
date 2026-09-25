import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("tmux wrapper refreshes only its target and clears absent tracked names", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-tmux-"));
  try {
    const bin = join(root, "bin");
    const log = join(root, "calls");
    const state = join(root, "session");
    mkdirSync(bin);
    const executable = join(bin, "tmux");
    writeFileSync(
      executable,
      `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TMUX_TEST_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "has-session") process.exit(fs.existsSync(process.env.TMUX_TEST_STATE) ? 0 : 1);
if (args[0] === "new-session") {
  fs.writeFileSync(process.env.TMUX_TEST_STATE, "");
  process.stdout.write("%1\\n");
}
if (args[0] === "show-options") process.stdout.write("OLD_TOKEN\\n");
if (args[0] === "attach-session") process.stdout.write("attached\\n");
`,
    );
    chmodSync(executable, 0o755);

    const secret = "value-must-not-appear-in-arguments";
    const result = spawnSync(
      "python3",
      [resolve("vm/tmux.py"), "dev", JSON.stringify(["NEW_TOKEN"])],
      {
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          NEW_TOKEN: secret,
          TMUX_TEST_LOG: log,
          TMUX_TEST_STATE: state,
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "attached\n");
    const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls, [
      ["has-session", "-t", "=dev"],
      ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "dev"],
      ["show-options", "-gqv", "@agentbox-environment-names"],
      [
        "set-option",
        "-g",
        "@agentbox-environment-names",
        "NEW_TOKEN OLD_TOKEN",
      ],
      ["set-environment", "-g", "-r", "NEW_TOKEN"],
      ["set-environment", "-t", "=dev", "NEW_TOKEN", secret],
      ["set-environment", "-g", "-r", "OLD_TOKEN"],
      ["set-environment", "-r", "-t", "=dev", "OLD_TOKEN"],
      ["respawn-pane", "-k", "-t", "%1"],
      ["attach-session", "-t", "=dev"],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
