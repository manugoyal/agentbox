#!/usr/bin/env node
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { configSchema, EXAMPLE_CONFIG, loadConfig } from "./config.js";
import { generateVM, hostMachine, Lima } from "./lima.js";
import { runSession } from "./session.js";
import { exchange } from "./git.js";
import { fail } from "./errors.js";

export const HELP = `Usage:
  agentbox vm config [options]        Print a Lima config sized for this host
  agentbox vm start [options]         Create if needed, then start the VM
  agentbox vm stop                    Stop the VM, retaining its disk
  agentbox vm status                  Show VM status
  agentbox run [options] -- COMMAND   Run in the VM with selected credentials
  agentbox -- COMMAND                Shorthand for run
  agentbox git init NAME              Create a bare exchange repository in the VM
  agentbox git push NAME [REFSPEC]    Push from this host checkout to the exchange
  agentbox git fetch NAME             Fetch into refs/remotes/agentbox/NAME/*

Options:
  -c, --config PATH        Host TOML config (default: ~/.config/agentbox/config.toml)
      --print-config      Print a commented example
      --vm NAME           Instance name (default: agentbox)
      --cpu-percent N     Share of host CPUs, rounded down (default: 75)
      --memory-percent N  Share of host RAM (default: 75)
      --disk-gib N        Guest disk capacity (default: 200)
      --ports N,N,...      Guest TCP ports to expose on host localhost
      --host-cpus N       Override detected specs when generating a config
      --host-memory-gib N Override detected host RAM
      --vm-type TYPE      vz or qemu (default: vz on macOS, qemu elsewhere)
  -p, --profile NAME       Host AWS profile issuing temporary, read-only credentials
  -r, --region REGION      AWS region (default: us-east-1)
  -s, --secret NAME=REF    Host 1Password op:// reference, or $REFERENCE_VARIABLE
  -h, --help              Show help
  -v, --version           Show version

Resource settings apply when creating a VM. Run this CLI on the host.
External permissions and token expiry are enforced by the issuing services.
`;

export function parseArguments(args: string[]) {
  const separator = args.indexOf("--");
  const before = separator < 0 ? args : args.slice(0, separator);
  const command = separator < 0 ? [] : args.slice(separator + 1);
  const { values, positionals } = parseArgs({
    args: before,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      "print-config": { type: "boolean" },
      vm: { type: "string" },
      "cpu-percent": { type: "string" },
      "memory-percent": { type: "string" },
      "disk-gib": { type: "string" },
      ports: { type: "string" },
      "host-cpus": { type: "string" },
      "host-memory-gib": { type: "string" },
      "vm-type": { type: "string" },
      profile: { type: "string", short: "p" },
      region: { type: "string", short: "r" },
      secret: { type: "string", short: "s", multiple: true },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  return { values, positionals, command };
}

export async function run(args = process.argv.slice(2)): Promise<number> {
  const { values, positionals, command } = parseArguments(args);
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    console.log("0.2.0");
    return 0;
  }
  if (values["print-config"]) {
    process.stdout.write(EXAMPLE_CONFIG);
    return 0;
  }
  const config = loadConfig(
    values.config,
    values.config !== undefined || process.env.AGENTBOX_CONFIG !== undefined,
  );
  if (values.vm) config.vm.name = values.vm;
  if (values["cpu-percent"] !== undefined)
    config.vm.cpu_percent = Number(values["cpu-percent"]);
  if (values["memory-percent"] !== undefined)
    config.vm.memory_percent = Number(values["memory-percent"]);
  if (values["disk-gib"] !== undefined)
    config.vm.disk_gib = Number(values["disk-gib"]);
  if (values.ports !== undefined)
    config.vm.ports =
      values.ports === "" ? [] : values.ports.split(",").map(Number);
  if (values.profile) config.run.aws_profile = values.profile;
  if (values.region) config.run.aws_region = values.region;
  for (const secret of values.secret ?? []) {
    const separator = secret.indexOf("=");
    if (separator < 1) fail("secret must be NAME=REFERENCE");
    config.run.secrets[secret.slice(0, separator)] = secret.slice(
      separator + 1,
    );
  }
  const valid = configSchema.safeParse(config);
  if (!valid.success) fail(`invalid settings: ${valid.error.message}`);
  const machine = hostMachine();
  if (values["host-cpus"] !== undefined)
    machine.cpus = Number(values["host-cpus"]);
  if (values["host-memory-gib"] !== undefined)
    machine.memoryBytes = Number(values["host-memory-gib"]) * 1024 ** 3;
  if (values["vm-type"]) {
    if (!["vz", "qemu"].includes(values["vm-type"]))
      fail("vm-type must be vz or qemu");
    machine.platform = values["vm-type"] === "vz" ? "darwin" : "linux";
  }
  const action = positionals[0] ?? "run";
  if (
    action === "vm" &&
    positionals[1] === "config" &&
    positionals.length === 2
  ) {
    process.stdout.write(generateVM(config.vm, machine));
    return 0;
  }
  if (action === "vm") {
    if (
      positionals.length !== 2 ||
      !["start", "stop", "status"].includes(positionals[1]!)
    )
      fail("use vm config, start, stop or status");
    const lima = new Lima(config);
    if (positionals[1] === "start") return lima.start(machine);
    if (positionals[1] === "stop") return lima.stop();
    console.log(lima.status());
    return 0;
  }
  if (action === "run") {
    if (positionals.length > 1 || !command.length)
      fail("provide a command after --");
    return runSession(new Lima(config).connection(), config.run, command);
  }
  if (action === "git") {
    const [, operation, name, refspec] = positionals;
    if (
      !operation ||
      !name ||
      positionals.length > 4 ||
      (refspec && operation !== "push")
    )
      fail("use git init NAME, git push NAME [REFSPEC], or git fetch NAME");
    return exchange(new Lima(config).connection(), operation, name, refspec);
  }
  fail(`unknown command ${action}; see --help`);
}

export function main(): void {
  run().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(
        `agentbox: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    },
  );
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
