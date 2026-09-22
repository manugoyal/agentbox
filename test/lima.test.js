import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import test from "node:test";

test("VM lifecycle creates once, keeps settings, and refuses host-sharing overrides", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-lifecycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const limaHome = join(root, "lima");
  const log = join(root, "calls.jsonl");
  const config = join(root, "config.toml");
  writeFileSync(
    config,
    `lima_home = ${JSON.stringify(limaHome)}\n[vm]\nname = "dev"\nports = [3000]\n`,
  );
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "limactl"),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, home:process.env.LIMA_HOME, ambient:process.env.AMBIENT_SECRET ?? null})+'\\n');
if(args[0]==='create') {
  const name = args[args.indexOf('--name')+1];
  const dir = path.join(process.env.LIMA_HOME, name);
  fs.mkdirSync(dir, {recursive:true});
  fs.writeFileSync(path.join(dir,'lima.yaml'), fs.readFileSync(0, 'utf8'));
}
if(args[0]==='list') process.stdout.write('Running\\n');
`,
    { mode: 0o755 },
  );
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [resolve("bin/agentbox.js"), "--config", config, ...args],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          AMBIENT_SECRET: "host-only",
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
  let result = run(
    "vm",
    "start",
    "--host-cpus",
    "8",
    "--host-memory-gib",
    "16",
  );
  assert.equal(result.status, 0, result.stderr);
  const instance = join(limaHome, "dev/lima.yaml");
  assert.equal(parse(readFileSync(instance, "utf8")).cpus, 6);
  result = run("vm", "start", "--host-cpus", "2");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parse(readFileSync(instance, "utf8")).cpus, 6);
  assert.equal(run("vm", "status").stdout.trim(), "Running");
  assert.equal(run("vm", "stop").status, 0);
  assert.equal(run("copy", "--recursive", "host directory", "src/").status, 0);
  assert.equal(run("cp", "host-file").status, 0);
  result = run("copy", "--from-guest", "build/output.tar", "host output.tar");
  assert.equal(result.status, 0, result.stderr);
  result = run("copy", "--from-guest", "build/output.tar");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HOST_PATH/);
  const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    calls.map((c) => c.args[0]),
    ["create", "start", "start", "list", "stop", "copy", "copy", "copy"],
  );
  assert.equal(calls[0].args.at(-1), "-");
  assert.deepEqual(calls[5].args, [
    "copy",
    "--recursive",
    "--",
    "host directory",
    "dev:src/",
  ]);
  assert.deepEqual(calls[6].args, ["copy", "--", "host-file", "dev:."]);
  assert.deepEqual(calls[7].args, [
    "copy",
    "--",
    "dev:build/output.tar",
    "host output.tar",
  ]);
  assert.ok(calls.every((c) => c.home === limaHome && c.ambient === null));

  mkdirSync(join(limaHome, "_config"));
  writeFileSync(
    join(limaHome, "_config/default.yaml"),
    'mounts: [{location: "~"}]\n',
  );
  result = run("vm", "start");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /global template/);
  rmSync(join(limaHome, "_config/default.yaml"));
  writeFileSync(
    instance,
    readFileSync(instance, "utf8").replace(
      "mounts: []",
      'mounts: [{location: "~"}]',
    ),
  );
  result = run("run", "--", "true");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no-host-sharing boundary/);
  assert.equal(
    readFileSync(log, "utf8").trim().split("\n").length,
    calls.length,
  );
});
