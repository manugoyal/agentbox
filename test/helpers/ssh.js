import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createConnection, createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { configSchema } from "../../dist/config.js";
import { generateVM } from "../../dist/lima.js";

export async function sshFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "agentbox-ssh-test-"));
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const key = join(root, "key");
  const generated = spawnSync("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    key,
  ]);
  if (generated.status !== 0) throw new Error(generated.stderr.toString());
  const serverConfig = join(root, "sshd_config");
  writeFileSync(
    serverConfig,
    `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${key}\nAuthorizedKeysFile ${key}.pub\nPidFile ${root}/pid\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nStrictModes no\nAllowUsers ${userInfo().username}\nLogLevel ERROR\n`,
  );
  const daemon = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", serverConfig], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let logs = "";
  daemon.stderr.on("data", (data) => {
    logs += data;
  });
  t.after(async () => {
    const exited = once(daemon, "exit");
    daemon.kill("SIGTERM");
    if (daemon.exitCode === null && !daemon.signalCode) await exited;
    rmSync(root, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    ready = await new Promise((resolve) => {
      const socket = createConnection({ port, host: "127.0.0.1" });
      socket.on("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) break;
    await delay(20);
  }
  if (!ready) throw new Error(`sshd failed: ${logs}`);
  const limaHome = join(root, "lima home");
  const instance = join(limaHome, "testvm");
  mkdirSync(instance, { recursive: true });
  const sshConfig = join(instance, "ssh.config");
  writeFileSync(
    sshConfig,
    `Host lima-testvm\n  HostName 127.0.0.1\n  Port ${port}\n  User ${userInfo().username}\n  IdentityFile ${key}\n  IdentitiesOnly yes\n  StrictHostKeyChecking yes\n  UserKnownHostsFile ${root}/known_hosts\n  LogLevel ERROR\n`,
  );
  const pub = readFileSync(`${key}.pub`, "utf8").trim();
  writeFileSync(join(root, "known_hosts"), `[127.0.0.1]:${port} ${pub}\n`);
  const config = configSchema.parse({
    lima_home: limaHome,
    vm: { name: "testvm" },
  });
  writeFileSync(join(instance, "lima.yaml"), generateVM(config.vm));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "limactl"),
    `#!${process.execPath}\nprocess.stdout.write('Running\\n');\n`,
    { mode: 0o755 },
  );
  const configPath = join(root, "agentbox.toml");
  writeFileSync(
    configPath,
    `lima_home = ${JSON.stringify(limaHome)}\n[vm]\nname = "testvm"\n`,
  );
  return {
    root,
    sshConfig,
    configPath,
    config,
    bin,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      AGENTBOX_CONFIG: configPath,
    },
  };
}
