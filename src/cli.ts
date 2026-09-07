#!/usr/bin/env node

/** Trusted launcher: resolve policy and selected credentials, then enter Linux namespaces. */
import { realpathSync } from "node:fs";
import { createInterface, type Interface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
  AgentboxConfig,
  DEFAULT_CONFIG_PATH,
  EXAMPLE_CONFIG,
} from "./config.js";
import { exportAwsCredentials, readSecrets } from "./credentials.js";
import { AgentboxError, fail } from "./errors.js";
import {
  loadPolicy,
  printableEmbeddedPolicy,
  networkSchema,
  type LoadedPolicy,
  type NetworkMode,
} from "./policy.js";
import {
  checkPlatform,
  launchSandbox,
  sandboxEnvironment,
} from "./linux-sandbox.js";

const VERSION = "0.1.0";

type ParsedArguments = {
  config?: string;
  profile?: string;
  region?: string;
  secrets: string[];
  settings?: string;
  printSettings: boolean;
  printConfig: boolean;
  yes: boolean;
  help: boolean;
  version: boolean;
  network?: NetworkMode;
  docker?: boolean;
  command: string[];
};

const HELP = `Usage: agentbox [options] -- <command> [arguments...]

Run a command in a lightweight Linux process jail with selected credentials.
The checkout is writable; the home, temp directory and network are private.

Options:
  -c, --config PATH       TOML config file (default: ${DEFAULT_CONFIG_PATH})
  -p, --profile NAME      AWS profile to exchange for temporary credentials
  -r, --region REGION     AWS region (default: us-east-1)
  -s, --secret NAME=REF   Inject NAME from an op:// 1Password reference or $VAR
      --settings PATH     Use an agentbox JSON policy instead of the defaults
      --print-settings    Print the embedded JSON policy and exit
      --print-config      Print a commented TOML config example and exit
      --network MODE      none (default) or host (includes localhost and LAN)
      --docker            Start a private Docker daemon inside the jail
  -y, --yes               Skip the launch confirmation
  -h, --help              Show this help
  -v, --version           Show the version

A command is required for a launch. Agentbox never supplies or changes the
command's own full-allow flags.
`;

function optionValue(
  argv: readonly string[],
  index: number,
  option: string,
): [string, number] {
  const inlineSeparator = option.indexOf("=");
  if (inlineSeparator >= 0) return [option.slice(inlineSeparator + 1), index];
  const value = argv[index + 1];
  if (value === undefined) fail(`${option} requires a value`);
  return [value, index + 1];
}

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const parsed: ParsedArguments = {
    secrets: [],
    printSettings: false,
    printConfig: false,
    yes: false,
    help: false,
    version: false,
    command: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--") {
      parsed.command = argv.slice(index + 1);
      break;
    }
    if (!argument.startsWith("-")) {
      parsed.command = argv.slice(index);
      break;
    }

    if (argument === "-h" || argument === "--help") parsed.help = true;
    else if (argument === "-v" || argument === "--version")
      parsed.version = true;
    else if (argument === "-y" || argument === "--yes") parsed.yes = true;
    else if (argument === "--print-settings") parsed.printSettings = true;
    else if (argument === "--print-config") parsed.printConfig = true;
    else if (argument === "--docker") parsed.docker = true;
    else if (argument === "--network" || argument.startsWith("--network=")) {
      const [value, nextIndex] = optionValue(argv, index, argument);
      const parsedNetwork = networkSchema.safeParse(value);
      if (!parsedNetwork.success) fail("--network must be none or host");
      parsed.network = parsedNetwork.data;
      index = nextIndex;
    } else if (
      argument === "-c" ||
      argument === "--config" ||
      argument.startsWith("--config=")
    ) {
      [parsed.config, index] = optionValue(argv, index, argument);
    } else if (
      argument === "-p" ||
      argument === "--profile" ||
      argument.startsWith("--profile=")
    ) {
      [parsed.profile, index] = optionValue(argv, index, argument);
    } else if (
      argument === "-r" ||
      argument === "--region" ||
      argument.startsWith("--region=")
    ) {
      [parsed.region, index] = optionValue(argv, index, argument);
    } else if (
      argument === "-s" ||
      argument === "--secret" ||
      argument.startsWith("--secret=")
    ) {
      const [secret, nextIndex] = optionValue(argv, index, argument);
      parsed.secrets.push(secret);
      index = nextIndex;
    } else if (
      argument === "--settings" ||
      argument.startsWith("--settings=")
    ) {
      [parsed.settings, index] = optionValue(argv, index, argument);
    } else {
      fail(`unknown option ${argument}; put child options after --`);
    }
  }
  return parsed;
}

function printLaunchSummary(options: {
  policy: LoadedPolicy;
  profile: string;
  identity: string;
  secrets: Readonly<Record<string, string>>;
  command: readonly string[];
}): void {
  console.error();
  console.error(`  settings       ${options.policy.label}`);
  console.error(
    `  filesystem ro  ${options.policy.filesystemGrants.readOnly.join(" ") || "(none)"}`,
  );
  console.error(
    `  filesystem rw  ${options.policy.filesystemGrants.readWrite.join(" ") || "(none)"}`,
  );
  console.error(`  network        ${options.policy.network}`);
  console.error(
    `  docker         ${options.policy.docker ? "private daemon" : "off"}`,
  );
  console.error(`  limits         ${JSON.stringify(options.policy.limits)}`);
  console.error(`  aws profile    ${options.profile || "(none)"}`);
  console.error(`  aws identity   ${options.identity}`);
  console.error(
    `  secrets        ${Object.keys(options.secrets).sort().join(" ") || "(none)"}`,
  );
  console.error(`  command        ${JSON.stringify(options.command)}`);
  console.error();
}

async function question(
  readline: Interface | undefined,
  message: string,
): Promise<string> {
  if (!readline) fail("cannot prompt during a noninteractive launch");
  try {
    return (await readline.question(message)).trim();
  } catch {
    return "";
  }
}

export async function run(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArguments(argv);

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.version) {
    console.log(VERSION);
    return 0;
  }
  if (args.printSettings) {
    process.stdout.write(printableEmbeddedPolicy());
    return 0;
  }
  if (args.printConfig) {
    process.stdout.write(EXAMPLE_CONFIG);
    return 0;
  }
  if (args.command.length === 0) {
    fail("a command is required; pass it after --");
  }

  checkPlatform();
  if (process.env.AGENTBOX_SRT_SETTINGS)
    fail(
      "AGENTBOX_SRT_SETTINGS is obsolete; migrate to AGENTBOX_SETTINGS and --print-settings",
    );
  if (!args.yes && !process.stdin.isTTY)
    fail("use --yes for a noninteractive launch");
  const config = new AgentboxConfig(
    args.config ?? DEFAULT_CONFIG_PATH,
    args.config !== undefined,
  );
  const region = args.region ?? config.get("aws_region", "us-east-1");
  const settings = (args.settings ?? config.get("settings")) || undefined;
  const policy = loadPolicy(settings, process.cwd(), {
    filesystem: config.filesystem,
    network: args.network ?? config.network,
    docker: args.docker ?? config.docker,
    dockerData: config.dockerData,
    limits: config.limits,
    protectedWritePaths: [config.path],
  });

  const readline = args.yes
    ? undefined
    : createInterface({
        input: process.stdin,
        output: process.stderr,
      });
  try {
    const profile = args.profile ?? config.get("aws_profile");

    const secretSpecifications = [...args.secrets];
    const namedSecrets = new Set(
      secretSpecifications.map(
        (specification) => specification.split("=", 1)[0],
      ),
    );
    for (const [name, reference] of Object.entries(config.secrets)) {
      if (!namedSecrets.has(name))
        secretSpecifications.push(`${name}=${reference}`);
    }
    let awsEnvironment: Record<string, string> = {};
    let identity = "(none)";
    if (profile) {
      const exported = exportAwsCredentials(profile, region);
      awsEnvironment = exported.environment;
      identity = exported.identity;
    }
    const secrets = readSecrets(secretSpecifications);

    if (!args.yes)
      printLaunchSummary({
        policy,
        profile,
        identity,
        secrets,
        command: args.command,
      });
    if (!args.yes) {
      const answer = (await question(readline, "Launch? [y/N] ")).toLowerCase();
      if (answer !== "y" && answer !== "yes") fail("aborted");
    }

    // Close readline before the child takes over the terminal. Leaving it active
    // would compete with full-screen coding-agent TUIs for stdin.
    readline?.close();
    const environment = sandboxEnvironment(policy, {
      ...config.env,
      ...awsEnvironment,
      ...secrets,
    });
    return await launchSandbox(policy, args.command, environment);
  } finally {
    readline?.close();
  }
}

let isMain = false;
if (process.argv[1] !== undefined) {
  try {
    // Keep the compiled module directly runnable for checkout-based workflows;
    // the package's stable bin wrapper calls main() explicitly instead.
    isMain =
      realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(process.argv[1]);
  } catch {
    isMain = false;
  }
}

export function main(argv = process.argv.slice(2)): void {
  run(argv).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      if (error instanceof AgentboxError) {
        console.error(`agentbox: ${error.message}`);
      } else {
        console.error(
          `agentbox: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      process.exitCode = 1;
    },
  );
}

if (isMain) main();
