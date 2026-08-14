#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

import { prepareBazelCompatibility } from "./bazel.js";
import { runChild } from "./child-process.js";
import {
  AgentboxConfig,
  DEFAULT_CONFIG_PATH,
  EXAMPLE_CONFIG,
  PROMPTED_SECRETS,
} from "./config.js";
import { exportAwsCredentials, readSecrets } from "./credentials.js";
import { AgentboxError, fail } from "./errors.js";
import {
  ensureLimaDockerBackend,
  limaBackendStatus,
  resetLimaDockerBackend,
  stopLimaDockerBackend,
} from "./lima-backend.js";
import {
  loadPolicy,
  printableEmbeddedPolicy,
  type LoadedPolicy,
} from "./policy.js";
import {
  ensureDirectory,
  isUsableDirectory,
  replaceProcessEnvironment,
} from "./system.js";

const VERSION = "0.1.0";

const PASSTHROUGH_ENV_VARS = [
  // Process basics.
  "HOME",
  "PATH",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "PWD",
  // Terminal.
  "TERM",
  "TERMINFO",
  "TERMINFO_DIRS",
  "COLORTERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TMUX",
  "TMUX_PANE",
  // Locale.
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
] as const;

const TOOL_CONFIG_DIRS = {
  DOCKER_CONFIG: join(homedir(), ".cache", "agentbox", "docker"),
  GH_CONFIG_DIR: join(homedir(), ".cache", "agentbox", "gh"),
  npm_config_cache: join(homedir(), ".cache", "agentbox", "npm"),
} as const;

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
  dockerAction?: "start" | "status" | "stop" | "reset";
  command: string[];
};

const HELP = `Usage: agentbox [options] -- <command> [arguments...]

Run an explicitly named command inside Anthropic Sandbox Runtime with only the
credentials and host environment values selected by agentbox.

Options:
  -c, --config PATH       TOML config file (default: ${DEFAULT_CONFIG_PATH})
  -p, --profile NAME      AWS profile to exchange for temporary credentials
  -r, --region REGION     AWS region (default: us-east-1)
  -s, --secret NAME=REF   Inject NAME from an op:// 1Password reference or $VAR
      --settings PATH     Use an SRT JSON policy instead of the embedded policy
      --print-settings    Print the embedded SRT policy and exit
      --print-config      Print a commented TOML config example and exit
      --docker-start      Start or verify the shared Lima Docker backend
      --docker-status     Show the shared Docker backend status
      --docker-stop       Stop the shared Docker backend
      --docker-reset      Delete the backend, including images and volumes
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
    else if (argument.startsWith("--docker-")) {
      const action = argument.slice("--docker-".length);
      if (
        !(["start", "status", "stop", "reset"] as const).includes(
          action as "start" | "status" | "stop" | "reset",
        )
      ) {
        fail(`unknown option ${argument}; put child options after --`);
      }
      if (parsed.dockerAction)
        fail("only one Docker backend action may be specified");
      parsed.dockerAction = action as ParsedArguments["dockerAction"];
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

function buildChildEnvironment(
  config: AgentboxConfig,
  credentials: Readonly<Record<string, string>>,
  secrets: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of PASSTHROUGH_ENV_VARS) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  Object.assign(environment, TOOL_CONFIG_DIRS);

  const inheritedTmpdir = environment.TMPDIR;
  if (!isUsableDirectory(inheritedTmpdir)) {
    if (inheritedTmpdir) {
      console.error(
        `agentbox: TMPDIR=${inheritedTmpdir} is missing or unwritable; ` +
          "falling back to /tmp",
      );
    }
    environment.TMPDIR = "/tmp";
  }

  if (!environment.LC_ALL && !environment.LC_CTYPE && !environment.LANG) {
    environment.LANG = "en_US.UTF-8";
  }

  // Plain config may adjust safe defaults such as GH_CONFIG_DIR, but selected
  // credentials come last and cannot be shadowed by a plain config value.
  Object.assign(environment, config.env, credentials, secrets);
  return environment;
}

function prepareRuntimeDirectories(): void {
  ensureDirectory("/tmp/claude");
  for (const directory of Object.values(TOOL_CONFIG_DIRS))
    ensureDirectory(directory);
}

function printLaunchSummary(options: {
  policy: LoadedPolicy;
  profile: string;
  identity: string;
  secrets: Readonly<Record<string, string>>;
  command: readonly string[];
}): void {
  console.log();
  console.log(`  srt settings   ${options.policy.label}`);
  console.log(`  aws profile    ${options.profile || "(none)"}`);
  console.log(`  aws identity   ${options.identity}`);
  console.log(
    `  secrets        ${Object.keys(options.secrets).sort().join(" ") || "(none)"}`,
  );
  console.log(`  command        ${JSON.stringify(options.command)}`);
  console.log();
}

async function question(readline: Interface, message: string): Promise<string> {
  try {
    return (await readline.question(message)).trim();
  } catch {
    return "";
  }
}

async function launch(
  command: readonly string[],
  policy: LoadedPolicy,
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  prepareRuntimeDirectories();
  let compatibility:
    Awaited<ReturnType<typeof prepareBazelCompatibility>> | undefined;

  try {
    const dockerEnvironment = await ensureLimaDockerBackend();
    if (dockerEnvironment) {
      // These Docker CLI settings can override or conflict with DOCKER_HOST.
      // The backend endpoint is the only daemon an agentbox launch may use.
      delete environment.DOCKER_CONTEXT;
      delete environment.DOCKER_TLS_VERIFY;
      delete environment.DOCKER_CERT_PATH;
      Object.assign(environment, dockerEnvironment);
    }
    await SandboxManager.initialize(policy.config);
    compatibility = prepareBazelCompatibility(environment.PATH ?? "");
    Object.assign(environment, compatibility.environment);
    environment.AGENTBOX_INTERNAL_COMMAND = Buffer.from(
      JSON.stringify(command),
    ).toString("base64url");
    environment.AGENTBOX_INTERNAL_NODE = process.execPath;
    environment.AGENTBOX_INTERNAL_RUNNER = fileURLToPath(
      new URL("./child-runner.js", import.meta.url),
    );
    // SRT's POSIX wrapper inherits process.env. Replacing it here is the actual
    // environment boundary: ambient AWS profiles, SSH agent sockets, and future
    // host credentials never reach the sandbox merely because they were set in
    // the shell that launched agentbox.
    replaceProcessEnvironment(environment);

    // SRT's POSIX API currently accepts a command string. Keep that string
    // constant and carry the user's argv out-of-band; child-runner decodes it
    // and uses spawn(shell:false), so no user argument is ever shell-parsed.
    const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
      'exec "$AGENTBOX_INTERNAL_NODE" "$AGENTBOX_INTERNAL_RUNNER"',
      "/bin/bash",
      undefined,
      undefined,
      process.cwd(),
    );
    const executable = argv[0];
    if (!executable) fail("srt produced an empty sandbox command");

    return await runChild(executable, argv.slice(1), {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
    });
  } finally {
    SandboxManager.cleanupAfterCommand();
    compatibility?.close();
    await SandboxManager.reset();
  }
}

async function runDockerAction(
  action: NonNullable<ParsedArguments["dockerAction"]>,
): Promise<number> {
  if (action === "start") {
    const environment = await ensureLimaDockerBackend();
    if (!environment)
      fail("Lima is not installed; on macOS, run: brew install lima");
    console.log(`Docker backend ready at ${environment.DOCKER_HOST}`);
    return 0;
  }
  if (action === "status") {
    const status = await limaBackendStatus();
    if (!status.installed) {
      console.log("Docker backend unavailable: Lima is not installed");
      return 0;
    }
    const detail = status.state?.message ? ` (${status.state.message})` : "";
    console.log(
      `Docker backend ${status.running ? "running" : (status.state?.status ?? "stopped")}${detail}`,
    );
    console.log(`Log: ${status.log}`);
    return 0;
  }
  if (action === "stop") {
    console.log(
      (await stopLimaDockerBackend())
        ? "Docker backend stopped"
        : "Docker backend is not running",
    );
    return 0;
  }
  await resetLimaDockerBackend();
  console.log("Docker backend reset; images, containers, and volumes removed");
  return 0;
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
  if (args.dockerAction) {
    if (args.command.length > 0)
      fail(`--docker-${args.dockerAction} cannot be combined with a command`);
    return runDockerAction(args.dockerAction);
  }
  if (args.command.length === 0) {
    fail("a command is required; pass it after --");
  }

  const config = new AgentboxConfig(
    args.config ?? DEFAULT_CONFIG_PATH,
    args.config !== undefined,
  );
  const region = args.region ?? config.get("aws_region", "us-east-1");
  const settings = (args.settings ?? config.get("srt_settings")) || undefined;
  const policy = loadPolicy(settings, process.cwd());

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    let profile = args.profile ?? config.get("aws_profile");
    if (!profile && !config.exists) {
      profile = await question(
        readline,
        "AWS profile (empty for no AWS access): ",
      );
    }

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
    if (!config.exists && secretSpecifications.length === 0) {
      for (const name of PROMPTED_SECRETS) {
        const reference = await question(
          readline,
          `1Password ref for ${name}, op:// or $VAR (empty to skip): `,
        );
        if (reference) secretSpecifications.push(`${name}=${reference}`);
      }
    }

    let awsEnvironment: Record<string, string> = {};
    let identity = "(none)";
    if (profile) {
      const exported = exportAwsCredentials(profile, region);
      awsEnvironment = exported.environment;
      identity = exported.identity;
    }
    const secrets = readSecrets(secretSpecifications);

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
    readline.close();
    const environment = buildChildEnvironment(config, awsEnvironment, secrets);
    return await launch(args.command, policy, environment);
  } finally {
    readline.close();
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
