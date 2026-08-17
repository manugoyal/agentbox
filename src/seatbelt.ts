/**
 * macOS network compatibility layered on top of SRT's generated Seatbelt
 * profile.
 *
 * SRT's restricted-network mode normally relies on proxy environment variables.
 * Build systems often create fresh environments that drop those variables, so
 * Agentbox permits direct outbound IP connections instead. The added rule is
 * deliberately limited to IP endpoints: using Seatbelt's broad `network*`
 * permission would also expose every host Unix-domain socket and undermine the
 * Docker and credential boundaries.
 *
 * This adapter depends on recognizable structure in SRT's generated profile and
 * fails closed if that structure changes. Direct IP access includes arbitrary
 * external destinations and loopback TCP services.
 */
const SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
const NETWORK_MARKER = "; Network\n";
const UNRESTRICTED_IP_EGRESS_RULE =
  '(allow network-outbound (remote ip "*:*"))';

/** Add direct IP egress while retaining SRT's Unix-socket path allowlist. */
export function allowUnrestrictedMacOSIpEgress(
  argv: readonly string[],
): string[] {
  if (process.platform !== "darwin") return [...argv];

  if (!argv.some((argument) => argument.includes(SANDBOX_EXECUTABLE))) {
    throw new Error("SRT did not produce a macOS sandbox-exec command");
  }
  // SRT's argv API currently returns [shell, "-c", wrappedString], while its
  // lower-level helper represents the profile as a distinct argument. Locate
  // the profile text rather than depending on either representation.
  const profileContainerIndex = argv.findIndex((argument) =>
    argument.includes(NETWORK_MARKER),
  );
  const profileContainer = argv[profileContainerIndex];
  if (profileContainerIndex < 0 || profileContainer === undefined) {
    throw new Error("unrecognized SRT macOS Seatbelt profile");
  }
  if (profileContainer.includes("(allow network*)")) {
    throw new Error(
      "SRT unexpectedly allowed every network operation, including Unix sockets",
    );
  }
  if (profileContainer.includes(UNRESTRICTED_IP_EGRESS_RULE)) return [...argv];

  const result = [...argv];
  result[profileContainerIndex] = profileContainer.replace(
    NETWORK_MARKER,
    `${NETWORK_MARKER}${UNRESTRICTED_IP_EGRESS_RULE}\n`,
  );
  return result;
}
