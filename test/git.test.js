import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Connection } from "../dist/lima.js";
import { sshFixture } from "./helpers/ssh.js";

test(
  "Git exchanges branches over SSH without changing the host checkout or running its hooks",
  {
    skip: process.platform !== "linux" || !existsSync("/usr/sbin/sshd"),
    timeout: 30000,
  },
  async (t) => {
    const f = await sshFixture(t);
    const name = `test_${randomUUID()}`;
    const origin = join(
      homedir(),
      ".local/share/agentbox/exchange",
      `${name}.git`,
    );
    t.after(() => rmSync(origin, { recursive: true, force: true }));
    const host = join(f.root, "host checkout");
    const guest = join(f.root, "guest checkout");
    mkdirSync(host);
    function checked(executable, args, options = {}) {
      const result = spawnSync(executable, args, {
        cwd: host,
        env: f.env,
        encoding: "utf8",
        timeout: 15000,
        ...options,
      });
      assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
      return result.stdout.trim();
    }
    const git = (...args) =>
      checked("git", ["-c", "core.hooksPath=/dev/null", ...args]);
    const agentbox = (...args) =>
      checked(process.execPath, [resolve("dist/cli.js"), "git", ...args]);
    git("init", "--initial-branch=main");
    writeFileSync(join(host, "work.txt"), "original\n");
    git("add", "work.txt");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-m",
      "initial",
    );
    const original = git("rev-parse", "HEAD");
    writeFileSync(join(host, "work.txt"), "uncommitted host work\n");
    const hookMarker = join(f.root, "hook-ran");
    const hooks = join(f.root, "hooks");
    mkdirSync(hooks);
    writeFileSync(
      join(hooks, "pre-push"),
      `#!/bin/sh\ntouch '${hookMarker}'\nexit 1\n`,
      { mode: 0o755 },
    );
    git("config", "core.hooksPath", hooks);

    assert.match(agentbox("init", name), /Guest Git origin:/);
    agentbox("push", name, "HEAD:refs/heads/main");
    const connection = new Connection(f.sshConfig, "lima-testvm", f.env);
    assert.equal(
      connection.capture(["git", "-C", origin, "config", "core.hooksPath"]),
      "/dev/null",
    );
    connection.capture([
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "clone",
      origin,
      guest,
    ]);
    connection.capture(["git", "-C", guest, "checkout", "-b", "guest-work"]);
    connection.capture(
      [
        "python3",
        "-c",
        "import sys; open(sys.argv[1], 'w').write(sys.stdin.read())",
        join(guest, "work.txt"),
      ],
      "committed guest work\n",
    );
    connection.capture([
      "git",
      "-C",
      guest,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-am",
      "guest change",
    ]);
    connection.capture([
      "git",
      "-C",
      guest,
      "-c",
      "core.hooksPath=/dev/null",
      "push",
      "origin",
      "guest-work",
    ]);
    agentbox("fetch", name);
    assert.equal(
      git("show", `refs/remotes/agentbox/${name}/guest-work:work.txt`),
      "committed guest work",
    );
    assert.equal(git("rev-parse", "HEAD"), original);
    assert.equal(
      readFileSync(join(host, "work.txt"), "utf8"),
      "uncommitted host work\n",
    );
    assert.equal(existsSync(hookMarker), false);
  },
);
