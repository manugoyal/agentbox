import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { sshFixture } from "./helpers/ssh.js";

test(
  "interactive SSH shell has job control, receives input and resizes",
  {
    skip: process.platform !== "linux" || !existsSync("/usr/sbin/sshd"),
    timeout: 25000,
  },
  async (t) => {
    const f = await sshFixture(t);
    const script =
      'test -t 0 && test -t 1 || exit 91; [[ $- == *m* ]] || exit 92; printf "INITIAL:"; stty size; printf "RESIZE_READY\\n"; read -r response; [[ "$response" == continue ]] || exit 93; printf "RESIZED:"; stty size; exit 23';
    const result = spawnSync(
      "python3",
      [
        resolve("test/helpers/terminal.py"),
        process.execPath,
        resolve("bin/agentbox.js"),
        "--",
        "bash",
        "--noprofile",
        "--norc",
        "-ic",
        script,
      ],
      {
        env: f.env,
        encoding: "utf8",
        timeout: 20000,
      },
    );
    assert.equal(
      result.status,
      23,
      `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
    );
    assert.match(result.stdout, /INITIAL:31 97/);
    assert.match(result.stdout, /RESIZED:47 111/);
    assert.doesNotMatch(
      result.stdout,
      /no job control|cannot set terminal process group/,
    );
  },
);
