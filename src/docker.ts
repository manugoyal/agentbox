/**
 * Optional Docker setup. newuidmap/newgidmap give bubblewrap only the caller's
 * allocated subordinate IDs. The command never runs in this outer namespace:
 * docker-runner enters a child user/mount/PID/network namespace first, locking
 * the inherited read-only mounts against even namespace-root remounts.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";

import { fail } from "./errors.js";

export function subordinateId(path: string, uid: number): number {
  const name = userInfo().username;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const [owner, start, count] = line.split(":");
    if (
      (owner === name || owner === String(uid)) &&
      Number(count) >= 65535 &&
      Number(start) > 0
    )
      return Number(start);
  }
  fail(
    `Docker mode requires at least 65535 subordinate IDs for ${name} in ${path}`,
  );
}

export function dockerMappingSetup(): (child: ChildProcess) => Promise<void> {
  const uid = process.getuid!(),
    gid = process.getgid!();
  const subuid = subordinateId("/etc/subuid", uid);
  const subgid = subordinateId("/etc/subgid", uid);
  return async (child) => {
    const infoIndex: number = 5;
    const info = child.stdio[infoIndex] as Readable;
    const block = child.stdio[4] as Writable;
    let data = "";
    info.setEncoding("utf8");
    info.on("data", (chunk) => {
      data += chunk;
    });
    const timeout = setTimeout(
      () =>
        info.destroy(
          new Error("timed out waiting for bubblewrap user namespace"),
        ),
      10000,
    );
    try {
      await once(info, "end");
      const pid = (JSON.parse(data) as { "child-pid": number })["child-pid"];
      if (!Number.isSafeInteger(pid) || pid <= 1)
        fail("invalid bubblewrap child PID");
      // Keep the enclosing scope's limits outside the writable cgroup view.
      // Nothing untrusted is running yet: bwrap is blocked on FD 4. Move its
      // whole scope into a child before the inner runner unshares cgroupns.
      const relative = readFileSync(`/proc/${pid}/cgroup`, "utf8")
        .trim()
        .split("0::")[1];
      if (!relative?.endsWith(".scope"))
        fail("Docker requires a fresh delegated cgroup v2 scope");
      const scope = join("/sys/fs/cgroup", relative);
      const workload = join(scope, "sandbox");
      mkdirSync(workload);
      for (const member of readFileSync(join(scope, "cgroup.procs"), "utf8")
        .trim()
        .split("\n")) {
        if (member) writeFileSync(join(workload, "cgroup.procs"), member);
      }
      const controllers = readFileSync(
        join(scope, "cgroup.controllers"),
        "utf8",
      )
        .trim()
        .split(/\s+/)
        .filter((name) =>
          ["cpu", "memory", "pids", "io", "cpuset"].includes(name),
        );
      writeFileSync(
        join(scope, "cgroup.subtree_control"),
        controllers.map((name) => `+${name}`).join(" "),
      );
      for (const [tool, id, start] of [
        ["newuidmap", uid, subuid],
        ["newgidmap", gid, subgid],
      ] as const) {
        const result = spawnSync(
          `/usr/bin/${tool}`,
          [String(pid), "0", String(id), "1", "1", String(start), "65535"],
          { encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin" } },
        );
        if (result.status !== 0)
          fail(`${tool} failed: ${result.stderr || result.error?.message}`);
      }
      block.end("1");
    } finally {
      clearTimeout(timeout);
    }
  };
}
