import { fail } from "./errors.js";
import { findExecutable, runChecked } from "./system.js";

const PRIVILEGED_MARKERS = [
  "Administrator",
  "FullAccess",
  "PowerUser",
  ":root",
] as const;

export type AwsCredentials = {
  environment: Record<string, string>;
  identity: string;
};

export function exportAwsCredentials(
  profile: string,
  region: string,
): AwsCredentials {
  if (!findExecutable("aws")) {
    fail("aws CLI is not installed, but an AWS profile was given");
  }

  const cleanProfiles = {
    AWS_PROFILE: null,
    AWS_DEFAULT_PROFILE: null,
  } as const;

  let exported: string;
  try {
    exported = runChecked(
      [
        "aws",
        "configure",
        "export-credentials",
        "--profile",
        profile,
        "--format",
        "env-no-export",
      ],
      cleanProfiles,
    );
  } catch (error) {
    fail(
      `could not export credentials for profile ${JSON.stringify(profile)}: ` +
        `${String(error)}\n         if it is an SSO profile, try: ` +
        `aws sso login --profile ${profile}`,
    );
  }

  const environment: Record<string, string> = {};
  for (const line of exported.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    if (name.startsWith("AWS_")) {
      environment[name] = line.slice(separator + 1).trim();
    }
  }
  if (!environment.AWS_ACCESS_KEY_ID) {
    fail(`profile ${JSON.stringify(profile)} produced no access key`);
  }
  environment.AWS_REGION = region;
  environment.AWS_DEFAULT_REGION = region;

  let identity: string;
  try {
    identity = runChecked(
      [
        "aws",
        "sts",
        "get-caller-identity",
        "--query",
        "Arn",
        "--output",
        "text",
      ],
      {
        ...environment,
        AWS_PROFILE: null,
        AWS_DEFAULT_PROFILE: null,
        AWS_CONFIG_FILE: null,
        AWS_SHARED_CREDENTIALS_FILE: null,
      },
    ).trim();
  } catch (error) {
    fail(
      `the exported credentials for ${JSON.stringify(profile)} do not work: ` +
        String(error),
    );
  }

  if (PRIVILEGED_MARKERS.some((marker) => identity.includes(marker))) {
    console.error(
      `agentbox: WARNING: ${identity} looks privileged, not read-only.`,
    );
  }
  return { environment, identity };
}

function resolveReference(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith("$")) return text;

  let name = text.slice(1);
  if (name.startsWith("{") && name.endsWith("}")) name = name.slice(1, -1);
  if (!name) fail(`${JSON.stringify(raw)} names no environment variable`);

  const value = process.env[name]?.trim();
  if (!value)
    fail(`$${name} is unset or empty, so there is no reference to read`);
  return value;
}

export function readSecrets(
  specifications: readonly string[],
): Record<string, string> {
  if (specifications.length === 0) return {};
  if (!findExecutable("op"))
    fail("op is not installed, but secrets were requested");

  const secrets: Record<string, string> = {};
  for (const specification of specifications) {
    const separator = specification.indexOf("=");
    const name = separator < 0 ? "" : specification.slice(0, separator);
    const rawReference =
      separator < 0 ? "" : specification.slice(separator + 1);
    if (!name || !rawReference) {
      fail(
        `bad secret ${JSON.stringify(specification)}, expected ` +
          "NAME=op://... or NAME=$VAR",
      );
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      fail(`${JSON.stringify(name)} is not a valid environment variable name`);
    }

    const reference = resolveReference(rawReference);
    if (!reference.startsWith("op://")) {
      fail(
        `${name} resolved to ${JSON.stringify(reference)}, which is not an ` +
          "op:// reference.\n         Pass an op:// path, or $VAR naming a " +
          "variable that holds one.",
      );
    }
    try {
      secrets[name] = runChecked(["op", "read", reference]).trim();
    } catch (error) {
      fail(
        `could not read ${reference}: ${String(error)}\n         is op signed in?`,
      );
    }
  }
  return secrets;
}
