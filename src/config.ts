/** Host-owned configuration. Only run.env and selected credential values enter the VM. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import { fail } from "./errors.js";
import { expandHome } from "./system.js";

export const nameSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/);
export const environmentSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  z.string().refine((value) => !value.includes("\0"), "NUL is not allowed"),
);
export const vmSchema = z
  .object({
    name: nameSchema.default("agentbox"),
    cpu_percent: z.number().positive().max(100).default(75),
    memory_percent: z.number().positive().max(100).default(75),
    disk_gib: z.number().int().min(20).max(100_000).default(200),
    ports: z.array(z.number().int().min(1).max(65535)).default([]),
  })
  .strict();
export const configSchema = z
  .object({
    lima_home: z
      .string()
      .min(1)
      .default(join(homedir(), ".local/share/agentbox/lima")),
    vm: vmSchema.default({}),
    run: z
      .object({
        aws_profile: z.string().min(1).optional(),
        aws_region: z.string().min(1).default("us-east-1"),
        secrets: environmentSchema.default({}),
        env: environmentSchema.default({}),
      })
      .strict()
      .default({}),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export type VMConfig = z.infer<typeof vmSchema>;
export const DEFAULT_CONFIG_PATH = join(
  homedir(),
  ".config/agentbox/config.toml",
);

export function loadConfig(
  path = process.env.AGENTBOX_CONFIG ?? DEFAULT_CONFIG_PATH,
  required = false,
): Config {
  let data: unknown = {};
  try {
    data = parse(readFileSync(resolve(expandHome(path)), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || required)
      fail(`cannot read config ${path}: ${String(error)}`);
  }
  const parsed = configSchema.safeParse(data);
  if (!parsed.success) fail(`invalid config ${path}: ${parsed.error.message}`);
  parsed.data.lima_home = resolve(expandHome(parsed.data.lima_home));
  return parsed.data;
}

export const EXAMPLE_CONFIG = `# Keep this configuration on the host, outside the VM.
# agentbox uses its own Lima directory so unrelated Lima defaults cannot add mounts.
# lima_home = "~/.local/share/agentbox/lima"

[vm]
name = "agentbox"
cpu_percent = 75
memory_percent = 75
disk_gib = 200
ports = [3000, 8000]

[run]
# This profile must issue temporary credentials with service-side read-only permissions.
# aws_profile = "agentbox-readonly"
aws_region = "us-east-1"

[run.secrets]
# Stored tokens must already have the required scopes and expiration.
# GH_TOKEN = "op://Agentbox/GitHub/token"
# BRAINTRUST_API_KEY = "op://Agentbox/Braintrust/token"

[run.env]
# BRAINTRUST_APP_URL = "http://localhost:3000"
`;
