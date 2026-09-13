import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { userInfo } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { sshFixture } from "./helpers/ssh.js";
const cli = resolve("dist/cli.js");
const available = process.platform === "linux" && existsSync("/usr/sbin/sshd");

test(
  "real SSH session carries selected credentials, stdin, argv and exit status",
  { skip: !available, timeout: 15000 },
  async (t) => {
    const f = await sshFixture(t);
    const token = 'test-only token $dollars "quotes"\nsecond line';
    writeFileSync(
      join(f.bin, "op"),
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(token)});\n`,
      { mode: 0o755 },
    );
    const expiry = new Date(Date.now() + 600000).toISOString();
    writeFileSync(
      join(f.bin, "aws"),
      `#!${process.execPath}\nif(process.env.AWS_ACCESS_KEY_ID)process.exit(2); process.stdout.write(${JSON.stringify(JSON.stringify({ AccessKeyId: "temporary-key", SecretAccessKey: "temporary-secret", SessionToken: "temporary-session", Expiration: expiry }))});\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      f.configPath,
      readFileSync(f.configPath, "utf8") +
        `\n[run]\naws_profile = "readonly"\n[run.secrets]\nSERVICE_TOKEN = "op://Tests/Service/token"\n`,
    );
    const program = `import json,os,sys
print(json.dumps({"argv":sys.argv[1:],"stdin":sys.stdin.buffer.read().hex(),"token":os.environ.get("SERVICE_TOKEN"),"aws":os.environ.get("AWS_SESSION_TOKEN"),"ambient":os.environ.get("AMBIENT_SECRET"),"op":os.environ.get("OP_SERVICE_ACCOUNT_TOKEN"),"agent":os.environ.get("SSH_AUTH_SOCK"),"cwd":os.getcwd()}))
sys.exit(37)`;
    const argument = "value with spaces \" ' $(touch should-not-exist)";
    const input = Buffer.from([0, 1, 2, 10, 255]);
    const result = spawnSync(
      process.execPath,
      [cli, "run", "--", "python3", "-c", program, argument],
      {
        env: {
          ...f.env,
          AMBIENT_SECRET: "hidden",
          OP_SERVICE_ACCOUNT_TOKEN: "host-login",
          AWS_ACCESS_KEY_ID: "ambient-key",
        },
        input,
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(result.status, 37, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      argv: [argument],
      stdin: input.toString("hex"),
      token,
      aws: "temporary-session",
      ambient: null,
      op: null,
      agent: null,
      cwd: userInfo().homedir,
    });
    assert.ok(!result.stderr.includes(token));
  },
);

test(
  "static AWS credentials fail before any value reaches the guest",
  { skip: !available, timeout: 15000 },
  async (t) => {
    const f = await sshFixture(t);
    writeFileSync(
      join(f.bin, "aws"),
      `#!${process.execPath}\nconsole.log(JSON.stringify({AccessKeyId:'static',SecretAccessKey:'do-not-log-me'}));\n`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      [cli, "run", "-p", "readonly", "--", "touch", join(f.root, "ran")],
      { env: f.env, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /temporary credentials/);
    assert.doesNotMatch(result.stderr, /do-not-log-me/);
    assert.equal(existsSync(join(f.root, "ran")), false);
  },
);
