/**
 * Two fixed stages inside the Docker jail, with no tool-specific argv rewriting.
 * The outer stage can administer the boundary's mounts, so it runs only trusted
 * setup and slirp4netns. A nested user namespace removes that authority before
 * starting dockerd or the user's command. Private proc hides the outer stage.
 * All stages live in the same launch-scoped cgroup and outer PID namespace.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { runChild } from "./child-process.js";

function checked(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`${command}: ${result.stderr || result.error?.message}`);
}

async function outer(command: string[], network: string): Promise<number> {
  let slirp: ChildProcess | undefined;
  try {
    return await runChild(
      "/usr/bin/unshare",
      [
        "--map-root-user",
        "--map-users=1:1:65535",
        "--map-groups=1:1:65535",
        "--mount",
        "--net",
        "--cgroup",
        "--pid",
        "--fork",
        "--kill-child",
        "--mount-proc",
        "--keep-caps",
        "--",
        process.execPath,
        fileURLToPath(import.meta.url),
        "inner",
        network,
        ...command,
      ],
      { stdio: "inherit", env: process.env },
      undefined,
      async (child) => {
        if (network === "none") {
          writeFileSync("/run/agentbox-network-ready", "");
          return;
        }
        const own = readlinkSync("/proc/self/ns/net");
        let ready = false;
        for (let i = 0; i < 200; i++) {
          if (readlinkSync(`/proc/${child.pid}/ns/net`) !== own) {
            ready = true;
            break;
          }
          await delay(10);
        }
        if (!ready)
          throw new Error("timed out creating Docker network namespace");
        slirp = spawn(
          "/usr/bin/slirp4netns",
          [
            "--configure",
            "--disable-host-loopback",
            "--enable-sandbox",
            "--enable-seccomp",
            "--ready-fd=3",
            String(child.pid),
            "tap0",
          ],
          { stdio: ["ignore", "ignore", "pipe", "pipe"] },
        );
        let error = "";
        slirp.stderr!.on("data", (data) => {
          error = (error + data).slice(-4000);
        });
        const fd = slirp.stdio[3]!;
        const timeout = setTimeout(
          () =>
            fd.destroy(new Error(`Docker network setup timed out: ${error}`)),
          10000,
        );
        try {
          await Promise.race([
            once(fd, "data"),
            once(slirp, "exit").then(() => {
              throw new Error(`slirp4netns exited: ${error}`);
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
        slirp.on("exit", () => child.kill("SIGTERM"));
        writeFileSync("/run/agentbox-network-ready", "");
      },
    );
  } finally {
    slirp?.kill("SIGTERM");
  }
}

function dockerReady(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      { socketPath: "/run/docker.sock", path: "/_ping", timeout: 500 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function inner(command: string[], network: string): Promise<number> {
  for (let i = 0; !existsSync("/run/agentbox-network-ready"); i++) {
    if (i > 1200) throw new Error("Docker network setup timed out");
    await delay(10);
  }
  if (network !== "none") {
    writeFileSync("/run/agentbox-resolv.conf", "nameserver 10.0.2.3\n");
    checked("/usr/bin/mount", [
      "--bind",
      "/run/agentbox-resolv.conf",
      "/etc/resolv.conf",
    ]);
  } else checked("/usr/sbin/ip", ["link", "set", "lo", "up"]);
  // A fresh sysfs and cgroupfs show this network and only the delegated scope.
  checked("/usr/bin/mount", ["-t", "sysfs", "-o", "ro", "sysfs", "/sys"]);
  checked("/usr/bin/mount", ["-t", "cgroup2", "cgroup2", "/sys/fs/cgroup"]);
  const dockerData = process.env.AGENTBOX_INTERNAL_DOCKER_DATA!;
  mkdirSync(dockerData, { recursive: true });
  const environment = JSON.parse(
    Buffer.from(process.env.AGENTBOX_INTERNAL_ENV!, "base64url").toString(),
  ) as NodeJS.ProcessEnv;
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, environment);
  process.env.DOCKER_HOST = "unix:///run/docker.sock";
  delete process.env.DOCKER_CONTEXT;
  delete process.env.DOCKER_TLS_VERIFY;
  delete process.env.DOCKER_CERT_PATH;
  // Docker runs as root only within the mapped user namespace. Its documented
  // --rootless switch enables RootlessKit integration, which we do not use.
  const daemon = spawn(
    "dockerd",
    [
      "--host=unix:///run/docker.sock",
      `--data-root=${dockerData}`,
      "--exec-root=/run/docker",
      "--pidfile=/run/docker.pid",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  let daemonError: Error | undefined;
  daemon.on("error", (error) => {
    daemonError = error;
  });
  for (const output of [daemon.stdout!, daemon.stderr!])
    output.on("data", (data) => {
      log = (log + data).slice(-8000);
    });
  try {
    let ready = false;
    for (let i = 0; i < 300; i++) {
      if (daemonError) throw daemonError;
      if (daemon.exitCode !== null || daemon.signalCode)
        throw new Error(`dockerd failed:\n${log}`);
      if (await dockerReady()) {
        ready = true;
        break;
      }
      await delay(100);
    }
    if (!ready) throw new Error(`dockerd did not become ready:\n${log}`);
    return await runChild(command[0]!, command.slice(1), {
      stdio: "inherit",
      env: process.env,
    });
  } finally {
    daemon.kill("SIGTERM");
    const timeout = setTimeout(() => daemon.kill("SIGKILL"), 3000);
    if (daemon.exitCode === null && !daemon.signalCode && !daemonError)
      await once(daemon, "exit");
    clearTimeout(timeout);
  }
}

const [stage, network, ...command] = process.argv.slice(2);
if (
  !command[0] ||
  !["none", "host"].includes(network ?? "") ||
  !["outer", "inner"].includes(stage ?? "")
) {
  throw new Error("invalid internal Docker runner arguments");
}
(stage === "outer" ? outer(command, network!) : inner(command, network!)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`agentbox: ${String(error)}`);
    process.exitCode = 1;
  },
);
