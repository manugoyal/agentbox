/**
 * Strict parsing for Agentbox's small user-facing configuration surface.
 *
 * An existing config is authoritative: omitted credentials are not inferred or
 * prompted for. Rejecting unknown keys and keeping secret references separate
 * from plain environment values makes the launcher's granted capabilities
 * visible and reviewable.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { parse } from "smol-toml";
import { z, ZodError } from "zod";

import { fail } from "./errors.js";
import { expandHome } from "./system.js";
import {
  filesystemSchema,
  limitsSchema,
  networkSchema,
  type NetworkMode,
  type ResourceLimits,
} from "./policy.js";

const CONFIG_ENV_VARS = {
  aws_profile: "AGENTBOX_AWS_PROFILE",
  aws_region: "AGENTBOX_AWS_REGION",
  settings: "AGENTBOX_SETTINGS",
} as const;

export type ConfigKey = keyof typeof CONFIG_ENV_VARS;

export const DEFAULT_CONFIG_PATH = resolve(
  expandHome(
    process.env.AGENTBOX_CONFIG ?? join(homedir(), ".config", "agentbox.toml"),
  ),
);

export const EXAMPLE_CONFIG = `# agentbox defaults. Every key is optional, but a file that exists is
# authoritative: agentbox will not prompt for anything it leaves out.

# AWS profile to exchange for temporary credentials on the host. Use a
# read-only profile: it, not the sandbox, bounds what AWS calls can do.
# aws_profile = "development-readonly"

# Region for those credentials.
# aws_region = "us-east-1"

# An agentbox JSON policy to use instead of the embedded defaults. Start
# one from \`agentbox --print-settings\`.
# settings = "~/.config/agentbox-settings.json"

# Network is private by default. "host" shares the workstation's network,
# including localhost, LAN services and abstract Unix sockets.
# network = "host"

# Optional private Docker daemon. Its persistent data directory must exist.
# Without docker_data, images and volumes disappear when the jail exits.
# docker = true
# docker_data = "~/.cache/agentbox/docker"

# Optional limits for the whole process tree (requires a systemd user manager).
# CPU is a percentage: 100 is one CPU, 400 is four CPUs.
[limits]
# memory = "8G"
# tasks = 512
# cpu = 400

# Additional directories the sandbox may access. Relative paths are resolved
# from the directory where agentbox is launched. A read_write grant also grants
# read access. Specific write protections still take precedence.
[filesystem]
# read_only = ["../shared-docs"]
# read_write = ["../related-checkout"]

# Environment variables to inject from 1Password. A value may be an op:// path,
# or $VAR naming a variable that holds one. The latter keeps references in your
# shell profile and secret values in 1Password.
[secrets]
# SERVICE_TOKEN = "$SERVICE_TOKEN_REFERENCE"

# Plain environment variables. Do not put secrets here: this file is not
# encrypted. Plain values are applied before injected credentials.
[env]
# SERVICE_ORG = "example-org"
# SERVICE_PROJECT = "example-project"
`;

const environmentName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "invalid environment variable name");

const environmentTable = z.record(environmentName, z.string()).default({});

const configSchema = z
  .object({
    aws_profile: z.string().optional(),
    aws_region: z.string().optional(),
    settings: z.string().optional(),
    network: networkSchema.optional(),
    docker: z.boolean().optional(),
    docker_data: z.string().min(1).optional(),
    limits: limitsSchema.default({}),
    filesystem: filesystemSchema.default({}),
    secrets: environmentTable,
    env: environmentTable,
  })
  .strict();

function describeValidationError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join("; ");
}

export class AgentboxConfig {
  readonly exists: boolean;
  readonly path: string;
  readonly secrets: Record<string, string> = {};
  readonly env: Record<string, string> = {};
  readonly network?: NetworkMode;
  readonly docker?: boolean;
  readonly dockerData?: string;
  readonly limits: ResourceLimits = {};
  readonly filesystem = {
    readOnly: [] as string[],
    readWrite: [] as string[],
  };
  readonly #values: Partial<Record<ConfigKey, string>> = {};

  constructor(path: string, required = false) {
    this.path = resolve(expandHome(path));

    let source: string;
    try {
      source = readFileSync(this.path, "utf8");
      this.exists = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" && !required) {
        this.exists = false;
        return;
      }
      if (code === "ENOENT") fail(`no config file at ${this.path}`);
      fail(`could not read ${this.path}: ${String(error)}`);
    }

    let parsed: unknown;
    try {
      parsed = parse(source);
    } catch (error) {
      fail(`could not parse ${this.path}: ${String(error)}`);
    }

    let validated: z.infer<typeof configSchema>;
    try {
      validated = configSchema.parse(parsed);
    } catch (error) {
      if (error instanceof ZodError) {
        fail(`${this.path}: ${describeValidationError(error)}`);
      }
      throw error;
    }

    Object.assign(this.secrets, validated.secrets);
    Object.assign(this.env, validated.env);
    this.network = validated.network;
    this.docker = validated.docker;
    this.dockerData = validated.docker_data;
    this.limits = validated.limits;
    this.filesystem.readOnly.push(...validated.filesystem.read_only);
    this.filesystem.readWrite.push(...validated.filesystem.read_write);
    for (const key of Object.keys(CONFIG_ENV_VARS) as ConfigKey[]) {
      const value = validated[key];
      if (value !== undefined) this.#values[key] = value;
    }
  }

  get(key: ConfigKey, fallback = ""): string {
    const environmentName = CONFIG_ENV_VARS[key];
    return process.env[environmentName] ?? this.#values[key] ?? fallback;
  }
}
