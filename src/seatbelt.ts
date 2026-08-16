const SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
const NETWORK_MARKER = "; Network\n";
const UNRESTRICTED_IP_EGRESS_RULE =
  '(allow network-outbound (remote ip "*:*"))';

/**
 * Let sandboxed programs connect directly to arbitrary IP destinations while
 * retaining SRT's separate Unix-socket path allowlist.
 *
 * SRT intentionally routes restricted networking through an authenticated
 * localhost proxy. Some build tools construct a fresh environment and cannot
 * see those proxy variables. A filtered `remote ip` Seatbelt rule admits only
 * IP networking; unlike `(allow network*)`, it does not also grant access to
 * every host Unix-domain socket.
 */
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
