/** Host-side VM management and SSH transport. No guest-to-host filesystem channel. */
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse, stringify } from "yaml";
import type { Config, VMConfig } from "./config.js";
import { fail, findExecutable, runChild } from "./system.js";

export type Machine = { cpus: number; memoryBytes: number; platform: string };
export function hostMachine(): Machine {
  return {
    cpus: cpus().length,
    memoryBytes: totalmem(),
    platform: process.platform,
  };
}
export function generateVM(config: VMConfig, machine = hostMachine()): string {
  if (
    !Number.isInteger(machine.cpus) ||
    machine.cpus < 1 ||
    !Number.isFinite(machine.memoryBytes) ||
    machine.memoryBytes <= 0
  )
    fail("invalid host machine specifications");
  const memoryMiB =
    Math.floor(
      (machine.memoryBytes * config.memory_percent) / 100 / (256 * 1024 ** 2),
    ) * 256;
  if (memoryMiB < 1024)
    fail("the requested memory share gives the VM less than 1 GiB");
  const template = parse(
    readFileSync(new URL("../vm/ubuntu.yaml", import.meta.url), "utf8"),
  );
  const doc = {
    ...template,
    vmType: machine.platform === "darwin" ? "vz" : "qemu",
    cpus: Math.max(1, Math.floor((machine.cpus * config.cpu_percent) / 100)),
    memory: `${memoryMiB}MiB`,
    disk: `${config.disk_gib}GiB`,
    portForwards: [
      ...[...new Set(config.ports)].map((port) => ({
        guestPort: port,
        hostPort: port,
        guestIP: "127.0.0.1",
        hostIP: "127.0.0.1",
        proto: "tcp",
        static: true,
      })),
      { guestIP: "0.0.0.0", proto: "any", ignore: true },
    ],
  };
  assertBoundary(doc);
  return `# Generated for ${machine.cpus} host CPUs and ${(machine.memoryBytes / 1024 ** 3).toFixed(1)} GiB RAM.\n${stringify(doc)}`;
}

export function assertBoundary(doc: any): void {
  const ssh = doc?.ssh;
  if (
    !doc ||
    typeof doc !== "object" ||
    doc.base ||
    !Array.isArray(doc.mounts) ||
    doc.mounts.length !== 0 ||
    !Array.isArray(doc.copyToHost) ||
    doc.copyToHost.length !== 0 ||
    ssh?.loadDotSSHPubKeys !== false ||
    ssh.forwardAgent ||
    ssh.forwardX11 ||
    ssh.forwardX11Trusted ||
    doc.propagateProxyEnv !== false
  )
    fail(
      "VM configuration violates the no-host-sharing boundary (mounts, copied files, agents, X11, proxy environment or base templates)",
    );
  const ports = doc.portForwards ?? [];
  const safePort = (port: any) =>
    port &&
    !port.guestSocket &&
    !port.hostSocket &&
    !port.reverse &&
    (port.ignore
      ? port.guestIP === "0.0.0.0" &&
        port.proto === "any" &&
        !port.guestPort &&
        !port.guestPortRange
      : port.hostIP === "127.0.0.1" &&
        port.proto === "tcp" &&
        port.static === true &&
        Number.isInteger(port.hostPort) &&
        port.hostPort >= 1 &&
        port.hostPort <= 65535 &&
        Number.isInteger(port.guestPort) &&
        port.guestPort >= 1 &&
        port.guestPort <= 65535);
  if (
    !Array.isArray(ports) ||
    !ports.some((port: any) => port?.ignore === true) ||
    !ports.every(safePort)
  )
    fail(
      "VM ports must disable implicit forwarding and only expose explicit localhost TCP ports",
    );
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function shellCommand(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

function transportEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of "HOME PATH USER LOGNAME TMPDIR TERM COLORTERM LANG LC_ALL LC_CTYPE LIMA_HOME".split(
    " ",
  ))
    if (source[key] !== undefined) result[key] = source[key];
  return result;
}

export class Lima {
  readonly env: NodeJS.ProcessEnv;
  readonly executable: string;
  constructor(readonly config: Config) {
    this.executable =
      findExecutable("limactl") ??
      fail(
        "limactl is required on the host; run agentbox there, outside the VM",
      );
    this.env = transportEnvironment({
      ...process.env,
      LIMA_HOME: config.lima_home,
    });
    for (const name of ["default.yaml", "override.yaml", "base.yaml"]) {
      if (existsSync(join(config.lima_home, "_config", name)))
        fail(
          `Lima's global template ${name} can override the isolation settings; use a dedicated lima_home without global templates`,
        );
    }
  }
  get instanceDir(): string {
    return join(this.config.lima_home, this.config.vm.name);
  }
  capture(args: string[]): string {
    const result = spawnSync(this.executable, args, {
      env: this.env,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 ** 2,
    });
    if (result.error || result.status !== 0)
      fail(`limactl failed: ${result.error?.message ?? result.stderr.trim()}`);
    return result.stdout.trim();
  }
  validateInstance(): void {
    const path = join(this.instanceDir, "lima.yaml");
    if (!existsSync(path))
      fail(`VM ${this.config.vm.name} does not exist; run agentbox vm start`);
    assertBoundary(parse(readFileSync(path, "utf8")));
  }
  status(): string {
    return this.capture([
      "list",
      "--format",
      "{{.Status}}",
      this.config.vm.name,
    ]);
  }
  async start(machine = hostMachine()): Promise<number> {
    if (!existsSync(join(this.instanceDir, "lima.yaml"))) {
      mkdirSync(this.config.lima_home, { recursive: true, mode: 0o700 });
      const code = await runChild(
        this.executable,
        ["create", "--tty=false", "--name", this.config.vm.name, "-"],
        {
          env: this.env,
          stdio: "inherit",
          input: generateVM(this.config.vm, machine),
        },
      );
      if (code) return code;
    }
    this.validateInstance();
    return runChild(
      this.executable,
      ["start", "--tty=false", this.config.vm.name],
      { env: this.env, stdio: "inherit" },
    );
  }
  async stop(): Promise<number> {
    return runChild(this.executable, ["stop", this.config.vm.name], {
      env: this.env,
      stdio: "inherit",
    });
  }
  connection(): Connection {
    this.validateInstance();
    if (this.status() !== "Running")
      fail(`VM ${this.config.vm.name} is not running; run agentbox vm start`);
    return new Connection(
      join(this.instanceDir, "ssh.config"),
      `lima-${this.config.vm.name}`,
      this.env,
    );
  }
}

export class Connection {
  readonly executable: string;
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
  constructor(
    sshConfig: string,
    readonly destination: string,
    env = process.env,
  ) {
    this.env = transportEnvironment(env);
    this.executable =
      findExecutable("ssh") ?? fail("OpenSSH is required on the host");
    this.args = [
      "-F",
      sshConfig,
      "-o",
      "ForwardAgent=no",
      "-o",
      "ForwardX11=no",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "SendEnv=-*",
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPath=none",
    ];
  }
  capture(command: readonly string[], input?: string): string {
    const result = spawnSync(
      this.executable,
      [...this.args, "-T", this.destination, shellCommand(command)],
      {
        env: this.env,
        input,
        encoding: "utf8",
        maxBuffer: 1024 ** 2,
        timeout: 30_000,
      },
    );
    // The remote output could contain request data; never echo it on an error.
    if (result.error || result.status !== 0)
      fail(
        `SSH setup failed (${result.error?.message ?? `exit ${result.status}`})`,
      );
    return result.stdout.trim();
  }
  run(command: readonly string[]): Promise<number> {
    const tty = process.stdin.isTTY && process.stdout.isTTY;
    return runChild(
      this.executable,
      [
        ...this.args,
        tty ? "-tt" : "-T",
        this.destination,
        shellCommand(command),
      ],
      { env: this.env, stdio: "inherit" },
    );
  }
  async writeOutput(
    command: readonly string[],
    destination: string,
  ): Promise<number> {
    const descriptor = openSync(
      destination,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    try {
      return await runChild(
        this.executable,
        [...this.args, "-T", this.destination, shellCommand(command)],
        { env: this.env, stdio: ["ignore", descriptor, "inherit"] },
      );
    } finally {
      closeSync(descriptor);
    }
  }
  gitCommand(): string {
    return shellCommand([this.executable, ...this.args]);
  }
}
