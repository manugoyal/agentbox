import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const cli = resolve("dist/cli.js");
const supported =
  process.platform === "linux" &&
  process.getuid() !== 0 &&
  existsSync("/usr/bin/bwrap");
// A supported Linux host must actually pass namespace checks. Do not silently
// turn a security regression or broken userns setup into a skipped test.
const linux = (name, fn) =>
  test(name, { skip: !supported, timeout: 15000 }, fn);

function fixture(t, config = "") {
  const directory = mkdtempSync(join(tmpdir(), "agentbox-integration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspace = join(directory, "workspace");
  const home = join(directory, "home");
  mkdirSync(workspace);
  mkdirSync(home);
  const configPath = join(directory, "agentbox.toml");
  writeFileSync(configPath, config);
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    AMBIENT_SECRET: "must-not-cross",
    SSH_AUTH_SOCK: join(directory, "agent.sock"),
    DOCKER_HOST: "unix:///run/docker.sock",
    NODE_OPTIONS: "",
  };
  delete env.AGENTBOX_SETTINGS;
  delete env.AGENTBOX_AWS_PROFILE;
  const args = (command, options = []) => [
    cli,
    "-y",
    "-c",
    configPath,
    ...options,
    "--",
    ...command,
  ];
  const run = (command, options = [], extra = {}) =>
    spawnSync(process.execPath, args(command, options), {
      cwd: workspace,
      env,
      encoding: "utf8",
      timeout: 10000,
      ...extra,
    });
  return { directory, workspace, home, configPath, env, args, run };
}

function succeeded(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function waitFor(predicate, description) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(30);
  }
  assert.fail(`timed out waiting for ${description}`);
}

function descendants(pid) {
  try {
    const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
    return children.flatMap((child) => [child, ...descendants(child)]);
  } catch {
    return [];
  }
}

function running(pid) {
  try {
    return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8"));
  } catch {
    return false;
  }
}

linux("exact argv, piped stdin, clean stdout and command exit status", (t) => {
  const f = fixture(t);
  const expected = [
    "spaces here",
    "single'quote",
    'double"quote',
    "$(touch injected)",
    "$HOME",
    "",
    "\n",
    "--help",
  ];
  const result = f.run(
    [
      "node",
      "-e",
      'console.log(JSON.stringify({args:process.argv.slice(1),input:require("node:fs").readFileSync(0,"utf8")}))',
      "--",
      ...expected,
    ],
    [],
    { input: "input must survive\n" },
  );
  assert.deepEqual(JSON.parse(succeeded(result)), {
    args: expected,
    input: "input must survive\n",
  });
  assert.equal(existsSync(join(f.workspace, "injected")), false);
  assert.equal(f.run(["sh", "-c", "exit 17"]).status, 17);
  assert.equal(f.run(["sh", "-c", "kill -TERM $$"]).status, 143);
  assert.notEqual(f.run(["not-an-installed-command"]).status, 0);
});

linux(
  "checkout writes persist; home, host tmp, siblings, credentials and processes stay private",
  (t) => {
    const f = fixture(t, '[env]\nSELECTED_TOKEN = "explicit-value"\n');
    const secret = join(f.directory, "outside-secret");
    writeFileSync(secret, "host-only");
    writeFileSync(join(f.home, "credential"), "host-only");
    symlinkSync(secret, join(f.workspace, "escape-link"));
    const script = `
    const assert = require('node:assert/strict'), fs = require('node:fs');
    for (const path of ${JSON.stringify([secret, join(f.home, "credential"), `/proc/${process.pid}/environ`, "/run/docker.sock", "/sys/fs/cgroup", "escape-link"])}) assert.equal(fs.existsSync(path), false, path);
    for (const name of ['AMBIENT_SECRET','SSH_AUTH_SOCK','DOCKER_HOST','NODE_OPTIONS','DBUS_SESSION_BUS_ADDRESS']) assert.equal(process.env[name], undefined, name);
    assert.equal(process.env.SELECTED_TOKEN, 'explicit-value');
    fs.writeFileSync('result', 'checkout');
    fs.writeFileSync(process.env.HOME + '/session-only', 'private');
    fs.writeFileSync('/tmp/session-only', 'private');
    const status=fs.readFileSync('/proc/self/status','utf8');
    assert.match(status, /NoNewPrivs:\\s+1/);
    assert.match(status, /CapEff:\\s+0000000000000000/);
    assert.equal(require('node:os').hostname(), 'agentbox');
    assert.notEqual(require('node:child_process').spawnSync('unshare',['-Ur','true']).status, 0);
    console.log('isolated');
  `;
    assert.equal(succeeded(f.run(["node", "-e", script])).trim(), "isolated");
    assert.equal(readFileSync(join(f.workspace, "result"), "utf8"), "checkout");
    assert.equal(existsSync(join(f.home, "session-only")), false);
    succeeded(
      f.run([
        "sh",
        "-c",
        'test ! -e /tmp/session-only && test ! -e "$HOME/session-only"',
      ]),
    );
  },
);

linux(
  "read-only grants override writable parents and protect configuration against replacement",
  (t) => {
    const f = fixture(t);
    const readonly = join(f.workspace, "docs");
    mkdirSync(readonly);
    writeFileSync(join(readonly, "reference"), "reference");
    const configDir = join(f.workspace, "launcher", "policy");
    mkdirSync(configDir, { recursive: true });
    const protectedConfig = join(configDir, "agentbox.toml");
    writeFileSync(
      protectedConfig,
      `[filesystem]\nread_only = [${JSON.stringify(readonly)}]\n`,
    );
    rmSync(f.configPath);
    symlinkSync(protectedConfig, f.configPath);
    const script = `
    const fs = require('node:fs'), assert = require('node:assert/strict');
    assert.equal(fs.readFileSync('docs/reference','utf8'), 'reference');
    for (const path of ['docs/reference', ${JSON.stringify(protectedConfig)}]) {
      assert.throws(() => fs.writeFileSync(path, 'bad'));
      assert.throws(() => fs.unlinkSync(path));
    }
    assert.throws(() => fs.renameSync('launcher', 'replaced-launcher'));
    assert.throws(() => fs.renameSync('launcher/policy', 'launcher/replaced-policy'));
    fs.writeFileSync('launcher/policy/unrelated', 'allowed');
  `;
    succeeded(f.run(["node", "-e", script]));
    assert.equal(
      readFileSync(join(readonly, "reference"), "utf8"),
      "reference",
    );
    assert.equal(readFileSync(join(configDir, "unrelated"), "utf8"), "allowed");
  },
);

linux("missing policy files do not create host-side placeholders", (t) => {
  const f = fixture(t);
  const configDir = join(f.workspace, "launcher");
  mkdirSync(configDir);
  const absent = join(configDir, "absent.toml");
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "-y",
      "--",
      "sh",
      "-c",
      `test ! -e '${absent}' && ! touch '${absent}'`,
    ],
    {
      cwd: f.workspace,
      env: { ...f.env, AGENTBOX_CONFIG: absent },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  succeeded(result);
  assert.equal(existsSync(absent), false);
});

async function capture(f, command, options = []) {
  const child = spawn(process.execPath, f.args(command, options), {
    cwd: f.workspace,
    env: f.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data) => (stdout += data));
  child.stderr.on("data", (data) => (stderr += data));
  const [status, signal] = await once(child, "exit");
  return { status, signal, stdout, stderr };
}

linux(
  "private network blocks workstation TCP; host mode enables it explicitly",
  async (t) => {
    const f = fixture(t);
    const server = createServer((socket) => socket.end("reachable"));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => server.close());
    const script = `const s = require('node:net').connect(${server.address().port},'127.0.0.1'); s.on('data',d=>process.stdout.write(d)); s.on('error',()=>process.exit(23)); s.setTimeout(1000,()=>process.exit(24));`;
    const denied = await capture(f, ["node", "-e", script]);
    assert.equal(denied.status, 23, denied.stderr);
    assert.equal(
      succeeded(
        await capture(f, ["node", "-e", script], ["--network", "host"]),
      ),
      "reachable",
    );
  },
);

linux(
  "private IPC permits local Unix sockets but hides workstation sockets",
  async (t) => {
    const f = fixture(t);
    const path = join(f.directory, "service.sock");
    const server = createServer((socket) => socket.end("host"));
    server.listen(path);
    await once(server, "listening");
    t.after(() => server.close());
    const script = `
    const net=require('node:net');
    const outside=net.connect(${JSON.stringify(path)});
    outside.on('connect',()=>process.exit(99));
    outside.on('error',()=>{
      const server=net.createServer(s=>s.end('private'));
      server.listen('/tmp/inside.sock',()=>{
        const client=net.connect('/tmp/inside.sock');
        client.on('data',d=>process.stdout.write(d));
        client.on('end',()=>server.close());
      });
    });
  `;
    assert.equal(
      succeeded(await capture(f, ["node", "-e", script])),
      "private",
    );
  },
);

linux(
  "Git worktrees receive common metadata without exposing sibling checkouts",
  (t) => {
    const f = fixture(t);
    const repository = join(f.directory, "repo");
    const git = (...args) =>
      succeeded(
        spawnSync("git", args, {
          encoding: "utf8",
          env: { PATH: f.env.PATH, HOME: f.home, GIT_CONFIG_NOSYSTEM: "1" },
        }),
      );
    git("init", "-q", repository);
    git(
      "-C",
      repository,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "initial",
    );
    const worktree = join(f.workspace, "worktree");
    git("-C", repository, "worktree", "add", "-qb", "sandbox", worktree);
    writeFileSync(join(repository, "outside"), "hidden");
    const result = spawnSync(
      process.execPath,
      f.args([
        "sh",
        "-c",
        `git status --porcelain && touch new-file && git add new-file && test ! -e '${repository}/outside'`,
      ]),
      { cwd: worktree, env: f.env, encoding: "utf8", timeout: 10000 },
    );
    succeeded(result);
    assert.match(git("-C", worktree, "status", "--porcelain"), /A  new-file/);
  },
);

for (const termination of ["normal", "SIGTERM", "SIGKILL"]) {
  linux(
    `all descendants die after ${termination} launcher termination`,
    async (t) => {
      const f = fixture(t);
      const ready = join(f.workspace, "ready");
      const script = `require('node:child_process').spawn('sleep',['30'],{detached:true,stdio:'ignore'}).unref(); require('node:fs').writeFileSync('ready','yes'); setInterval(()=>{ ${termination === "normal" ? "if(require('node:fs').existsSync('finish')) process.exit(0);" : ""} },50);`;
      const child = spawn(process.execPath, f.args(["node", "-e", script]), {
        cwd: f.workspace,
        env: f.env,
        stdio: "ignore",
      });
      t.after(() => child.kill("SIGKILL"));
      const exited = once(child, "exit");
      await waitFor(() => existsSync(ready), "sandbox child");
      const pids = descendants(child.pid);
      assert.ok(
        pids.length >= 3,
        `expected bubblewrap and descendants, got ${pids}`,
      );
      if (termination === "normal")
        writeFileSync(join(f.workspace, "finish"), "");
      else child.kill(termination);
      await exited;
      await waitFor(
        () => pids.every((pid) => !running(pid)),
        "descendant cleanup",
      );
    },
  );
}

linux(
  "cgroup limits apply to the whole tree without exposing the systemd bus or secrets in argv",
  async (t) => {
    const f = fixture(
      t,
      '[limits]\nmemory = "128M"\ntasks = 32\ncpu = 50\n[env]\nSELECTED_TOKEN = "literal $HOME value"\n',
    );
    const ready = join(f.workspace, "ready");
    const child = spawn(
      process.execPath,
      f.args([
        "node",
        "-e",
        `const a=require('node:assert/strict'); a.equal(process.env.SELECTED_TOKEN,'literal $HOME value'); a.equal(process.env.DBUS_SESSION_BUS_ADDRESS,undefined); a.equal(require('node:fs').existsSync(process.env.XDG_RUNTIME_DIR+'/bus'),false); require('node:fs').writeFileSync('ready',''); setInterval(()=>{},1000)`,
      ]),
      { cwd: f.workspace, env: f.env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (data) => (stderr += data));
    t.after(() => child.kill("SIGKILL"));
    await waitFor(
      () => existsSync(ready) || child.exitCode !== null,
      "limited command",
    );
    assert.equal(child.exitCode, null, stderr);
    const pids = descendants(child.pid);
    const cgroup = readFileSync(`/proc/${pids.at(-1)}/cgroup`, "utf8")
      .trim()
      .split("::")[1];
    const root = join("/sys/fs/cgroup", cgroup);
    assert.match(cgroup, /\.scope$/);
    assert.equal(
      readFileSync(join(root, "memory.max"), "utf8").trim(),
      String(128 * 1024 * 1024),
    );
    assert.equal(
      readFileSync(join(root, "memory.swap.max"), "utf8").trim(),
      "0",
    );
    assert.equal(readFileSync(join(root, "pids.max"), "utf8").trim(), "32");
    const [quota, period] = readFileSync(join(root, "cpu.max"), "utf8")
      .trim()
      .split(" ")
      .map(Number);
    assert.equal(quota / period, 0.5);
    for (const pid of pids)
      assert.equal(
        readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(
          "--setenv\0SELECTED_TOKEN",
        ),
        false,
      );
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    await waitFor(
      () => pids.every((pid) => !running(pid)),
      "limited descendant cleanup",
    );
  },
);

linux(
  "configured memory limit kills only the oversized sandboxed workload",
  (t) => {
    const f = fixture(t, '[limits]\nmemory = "64M"\ntasks = 32\n');
    const result = f.run([
      "python3",
      "-c",
      "data = bytearray(128 * 1024 * 1024); print('should not fit')",
    ]);
    assert.equal(result.status, 137, result.stderr);
    assert.equal(result.stdout, "");
  },
);
