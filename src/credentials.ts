/** Resolve only selected credentials on the host. Scopes are enforced by each service. */
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { fail } from "./errors.js";
import { findExecutable } from "./system.js";

function readCredential(
  tool: string,
  args: string[],
  env = process.env,
): string {
  const executable =
    findExecutable(tool) ??
    fail(`${tool} is required on the host for the selected credentials`);
  const result = spawnSync(executable, args, {
    env,
    encoding: "utf8",
    maxBuffer: 1024 ** 2,
    timeout: 120_000,
  });
  // Neither stdout nor stderr from credential tools is safe to echo blindly.
  if (result.error || result.status !== 0)
    fail(
      `${tool} credential lookup failed; check the selected profile/reference and authenticate on the host`,
    );
  return result.stdout;
}

const awsExport = z.object({
  AccessKeyId: z.string().min(1),
  SecretAccessKey: z.string().min(1),
  SessionToken: z.string().min(1),
  Expiration: z.string().min(1),
});
export function exportAwsCredentials(
  profile: string,
  region: string,
): { environment: Record<string, string>; expiration: string } {
  const env = { ...process.env };
  for (const key of [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
  ])
    delete env[key];
  let value: z.infer<typeof awsExport>;
  try {
    value = awsExport.parse(
      JSON.parse(
        readCredential(
          "aws",
          [
            "configure",
            "export-credentials",
            "--profile",
            profile,
            "--format",
            "process",
          ],
          env,
        ),
      ),
    );
  } catch {
    fail(
      "AWS profile must provide temporary credentials with a session token and expiration; authenticate with the selected role or SSO profile on the host",
    );
  }
  const expiration = Date.parse(value.Expiration);
  if (!Number.isFinite(expiration) || expiration <= Date.now() + 30_000)
    fail(
      "AWS credentials are expired or about to expire; refresh the host session",
    );
  return {
    expiration: value.Expiration,
    environment: {
      AWS_ACCESS_KEY_ID: value.AccessKeyId,
      AWS_SECRET_ACCESS_KEY: value.SecretAccessKey,
      AWS_SESSION_TOKEN: value.SessionToken,
      AWS_REGION: region,
      AWS_DEFAULT_REGION: region,
    },
  };
}

export function readSecrets(
  specifications: readonly string[],
): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const specification of specifications) {
    const separator = specification.indexOf("=");
    const name = specification.slice(0, separator);
    let reference = specification.slice(separator + 1).trim();
    if (separator < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      fail("secret must be NAME=op://... or NAME=$REFERENCE_VARIABLE");
    if (reference.startsWith("$")) {
      const variable = reference.slice(1).replace(/^\{(.*)\}$/, "$1");
      reference = process.env[variable]?.trim() ?? "";
    }
    if (!reference.startsWith("op://"))
      fail(`secret ${name} must resolve to an op:// reference`);
    secrets[name] = readCredential("op", ["read", "--no-newline", reference]);
  }
  return secrets;
}
