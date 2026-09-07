import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const enabled = process.env.AGENTBOX_TEST_DOCKER === "1";
const dockerTest = (name, fn) =>
  test(name, { skip: !enabled, timeout: 30000 }, fn);
const cli = resolve("dist/cli.js");

function fixture(t, options = "") {
  const directory = mkdtempSync(join(tmpdir(), "agentbox-docker-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspace = join(directory, "workspace");
  const home = join(directory, "home");
  const reference = join(workspace, "reference");
  mkdirSync(reference, { recursive: true });
  mkdirSync(home);
  writeFileSync(join(reference, "file"), "protected");
  writeFileSync(join(directory, "outside"), "hidden");
  const rootfs = join(workspace, "rootfs");
  mkdirSync(join(rootfs, "bin"), { recursive: true });
  mkdirSync(join(rootfs, "www"));
  copyFileSync("/usr/bin/busybox", join(rootfs, "bin", "busybox"));
  symlinkSync("busybox", join(rootfs, "bin", "sh"));
  writeFileSync(join(rootfs, "www", "index.html"), "private-http");
  const tar = spawnSync(
    "tar",
    [
      "--owner=0",
      "--group=0",
      "-C",
      rootfs,
      "-cf",
      join(workspace, "rootfs.tar"),
      ".",
    ],
    { encoding: "utf8" },
  );
  assert.equal(tar.status, 0, tar.stderr);
  const config = join(directory, "agentbox.toml");
  writeFileSync(
    config,
    `${options}\n[filesystem]\nread_only = [${JSON.stringify(reference)}]\n[limits]\nmemory = "512M"\ntasks = 256\n`,
  );
  const env = {
    ...process.env,
    HOME: home,
    PATH: "/usr/bin:/usr/sbin:/bin:/sbin",
    AMBIENT_SECRET: "host-only",
    NODE_OPTIONS: "",
  };
  delete env.AGENTBOX_AWS_PROFILE;
  delete env.AGENTBOX_SETTINGS;
  const args = (command, network = "none") => [
    cli,
    "-y",
    "-c",
    config,
    "--docker",
    "--network",
    network,
    "--",
    ...command,
  ];
  const run = (command, network) =>
    spawnSync(process.execPath, args(command, network), {
      cwd: workspace,
      env,
      encoding: "utf8",
      timeout: 20000,
    });
  return { directory, workspace, home, reference, config, env, args, run };
}

const importImage = "docker import rootfs.tar agentbox-test >/dev/null\n";
function success(result) {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

dockerTest(
  "real containers, namespace-root containment, mounts, networks and cgroup limits",
  (t) => {
    const f = fixture(t);
    const script = `set -eu
${importImage}
docker run --rm --user 1234:1234 agentbox-test /bin/busybox id -u
docker run --rm -v "$PWD:/work" agentbox-test /bin/busybox touch /work/from-container
docker run --rm --cap-add ALL --security-opt seccomp=unconfined --pid=host --network=host -v /:/jail agentbox-test /bin/sh -ec '
  test ! -e /jail${f.directory}/outside
  test ! -e /jail${f.home}/.ssh
  ! /bin/busybox mount -o remount,rw /jail${f.reference}
  ! echo corrupt > /jail${f.reference}/file
  echo max > /jail/sys/fs/cgroup/memory.max
'
docker run -d -p 127.0.0.1:18080:8080 agentbox-test /bin/busybox httpd -f -p 8080 -h /www >/dev/null
curl -fsS --retry 10 --retry-connrefused --retry-delay 0 --max-time 5 http://127.0.0.1:18080/
`;
    const output = success(f.run(["sh", "-c", script]));
    assert.match(output, /1234/);
    assert.match(output, /private-http/);
    assert.equal(readFileSync(join(f.reference, "file"), "utf8"), "protected");
    assert.ok(existsSync(join(f.workspace, "from-container")));
  },
);

dockerTest("Docker storage can be shared explicitly across launches", (t) => {
  const data = mkdtempSync(join(tmpdir(), "agentbox-docker-data-test-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const f = fixture(t, `docker_data = ${JSON.stringify(data)}`);
  success(f.run(["sh", "-c", importImage]));
  assert.equal(
    success(
      f.run([
        "docker",
        "run",
        "--rm",
        "agentbox-test",
        "/bin/busybox",
        "echo",
        "cached",
      ]),
    ).trim(),
    "cached",
  );
});

dockerTest(
  "outbound Docker networking and daemon cleanup stay inside the launch",
  async (t) => {
    const f = fixture(t);
    const child = spawn(
      process.execPath,
      f.args(
        [
          "sh",
          "-c",
          `${importImage}\necho max > /sys/fs/cgroup/memory.max\ndocker run -d agentbox-test /bin/busybox sleep 60 > ready\nsleep 60`,
        ],
        "host",
      ),
      { cwd: f.workspace, env: f.env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (data) => (stderr += data));
    t.after(() => child.kill("SIGKILL"));
    for (
      let i = 0;
      i < 500 &&
      !existsSync(join(f.workspace, "ready")) &&
      child.exitCode === null;
      i++
    )
      await delay(20);
    assert.ok(existsSync(join(f.workspace, "ready")), stderr);
    function descendants(pid) {
      try {
        return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map(Number)
          .flatMap((p) => [p, ...descendants(p)]);
      } catch {
        return [];
      }
    }
    const pids = descendants(child.pid);
    assert.ok(pids.length > 6);
    const relative = readFileSync(`/proc/${pids[0]}/cgroup`, "utf8")
      .trim()
      .split("0::")[1];
    assert.match(relative, /\.scope\/sandbox$/);
    const scope = join("/sys/fs/cgroup", relative.slice(0, -"/sandbox".length));
    assert.equal(
      readFileSync(join(scope, "memory.max"), "utf8").trim(),
      String(512 * 1024 * 1024),
    );
    assert.equal(
      readFileSync(join(scope, "sandbox", "memory.max"), "utf8").trim(),
      "max",
    );
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    for (let i = 0; i < 100; i++) {
      if (
        pids.every(
          (pid) =>
            !existsSync(`/proc/${pid}/status`) ||
            /^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8")),
        )
      )
        return;
      await delay(20);
    }
    assert.fail("Docker descendants survived the launcher");
  },
);

dockerTest(
  "user runtime hooks execute only after the restrictive namespace is entered",
  (t) => {
    const f = fixture(t);
    const probe = join(f.workspace, "probe.cjs");
    writeFileSync(
      probe,
      `const result = require('node:child_process').spawnSync('/usr/bin/mount', ['-o','remount,rw',${JSON.stringify(f.reference)}]); require('node:assert/strict').notEqual(result.status, 0, 'preload ran with authority over the outer mounts');`,
    );
    writeFileSync(
      f.config,
      `${readFileSync(f.config, "utf8")}\n[env]\nNODE_OPTIONS = ${JSON.stringify(`--require=${probe}`)}\n`,
    );
    assert.equal(
      success(
        f.run([process.execPath, "-e", "console.log('hook-confined')"]),
      ).trim(),
      "hook-confined",
    );
  },
);
