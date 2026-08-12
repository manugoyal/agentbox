import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { parse } from "smol-toml";
import { z, ZodError } from "zod";

import { fail } from "./errors.js";
import { expandHome } from "./system.js";

const CONFIG_ENV_VARS = {
  aws_profile: "AGENTBOX_AWS_PROFILE",
  aws_region: "AGENTBOX_AWS_REGION",
  srt_settings: "AGENTBOX_SRT_SETTINGS",
} as const;

export type ConfigKey = keyof typeof CONFIG_ENV_VARS;

export const DEFAULT_CONFIG_PATH = resolve(
  expandHome(
    process.env.AGENTBOX_CONFIG ?? join(homedir(), ".config", "agentbox.toml"),
  ),
);

export const PROMPTED_SECRETS = [
  "GH_TOKEN",
  "BRAINTRUST_API_KEY",
  "DATADOG_SERVICE_ACCESS_TOKEN",
] as const;

export const EXAMPLE_CONFIG = `# agentbox defaults. Every key is optional, but a file that exists is
# authoritative: agentbox will not prompt for anything it leaves out.

# AWS profile to exchange for temporary credentials on the host. Use a
# read-only profile: it, not the sandbox, bounds what AWS calls can do.
aws_profile = "development-readonly"

# Region for those credentials.
aws_region = "us-east-1"

# An srt policy file to use instead of the policy embedded in agentbox. Start
# one from \`agentbox --print-settings\`.
# srt_settings = "~/.srt.json"

# Environment variables to inject from 1Password. A value may be an op:// path,
# or $VAR naming a variable that holds one. The latter keeps references in your
# shell profile and secret values in 1Password.
[secrets]
GH_TOKEN = "$GH_TOKEN_REFERENCE"
BRAINTRUST_API_KEY = "$BRAINTRUST_API_KEY_REFERENCE"
DATADOG_SERVICE_ACCESS_TOKEN = "$DATADOG_SERVICE_ACCESS_TOKEN_REFERENCE"

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
    srt_settings: z.string().optional(),
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
