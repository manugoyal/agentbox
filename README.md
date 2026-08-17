# agentbox

`agentbox` gives a coding agent broad authority over one checkout without giving
it the same authority over the rest of the host. It runs an explicitly named
command inside [Anthropic Sandbox Runtime
(SRT)](https://github.com/anthropic-experimental/sandbox-runtime), with a small
host environment and only the credentials the user selects.

The main command runs directly on the host under an OS sandbox, not inside a
virtual machine. This keeps normal development workflows fast and makes the
workspace feel native, while placing boundaries around host files, processes,
credentials, and local services.

## Security model

Agentbox builds the sandbox from several independent layers:

- **Filesystem and processes.** SRT gives the command read/write access to the
  current checkout, temporary files, and selected development-tool state. The
  rest of the home directory is denied by default, sensitive launcher settings
  are protected from modification, and child processes inherit the same OS
  sandbox. The agent is expected to have complete control of the checkout and
  the other explicitly writable paths.
- **Environment and credentials.** Agentbox constructs a new environment from a
  small allowlist instead of inheriting the launcher's environment wholesale.
  It resolves 1Password references and exchanges AWS profiles on the host, then
  injects only the resulting values. The sandbox does not receive access to the
  1Password session, `~/.aws`, SSH agent sockets, or other ambient credentials.
  An injected credential is still a capability: its service-side permissions
  remain the ultimate limit on what the agent can do with it.
- **Network and host services.** Outbound IP networking, including loopback TCP,
  is unrestricted so general development tools work without per-project network
  configuration. Unix-domain sockets and macOS Mach services remain scoped;
  this prevents ambient access to services such as the host Docker daemon or an
  SSH agent. Because IP egress is unrestricted, sandboxed code can transmit any
  workspace data or injected credential it can read.
- **Docker.** Agentbox never grants access to the host Docker socket. When Lima
  is available, it exposes an unrestricted Docker daemon inside a separate VM
  with no host filesystem mounts. The agent may fully control that guest, but
  that authority does not imply control of the host.

This is a practical containment boundary for developer tooling, not a complete
confidentiality boundary or a substitute for narrowly scoped credentials. The
embedded policy is primarily exercised on macOS; custom SRT settings replace
that policy and must be reviewed independently.

## Prerequisites

Agentbox requires Node.js 20.11 or newer and the command you intend to run. SRT
is installed automatically as an npm dependency; do not install it separately.

On Linux, SRT also requires `bubblewrap`, `socat`, and `ripgrep`.

The following tools are optional:

- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
  when selecting an AWS profile.
- [1Password CLI](https://www.1password.dev/cli/get-started) when injecting
  secrets. `op` must be signed in on the host.
- [Lima](https://lima-vm.io/) when running tests or development tools that
  launch Docker containers. On macOS, install it with `brew install lima`.

## Build and install from a checkout

For normal use, build the checkout and expose `agentbox` on your `PATH`:

```sh
npm install
npm run install:global
```

This does not publish anything. `npm install` installs the pinned runtime and
development dependencies. `install:global` compiles `src/`, then asks npm to
pack and install an independent snapshot of the checkout. Later edits and
builds in the checkout do not affect the installed command. Verify the
installation with:

```sh
agentbox --version
```

Run `npm run install:global` again whenever you want to replace the global
command with a new snapshot. Remove the installation with `npm uninstall
--global agentbox`.

### Work directly from the checkout

While developing agentbox, an npm link avoids reinstalling after every change:

```sh
npm install
npm run build
npm link
```

The global `agentbox` command now points at this checkout. Rebuild after editing
the TypeScript; the link itself does not need to be recreated:

```sh
npm run build
# Or keep the compiler running:
npm run build -- --watch
```

Remove the development link with `npm unlink --global agentbox`.

To run without either kind of global installation, build and invoke the entry
point with Node:

```sh
npm install
npm run build
node dist/cli.js -- bash
```

## Usage

A command is always required and should follow `--`:

```sh
agentbox -- bash
agentbox -y -- claude --dangerously-skip-permissions
agentbox -p development-readonly -- aws sts get-caller-identity
agentbox -s 'GH_TOKEN=$GH_TOKEN_REFERENCE' -- gh repo view
```

Agentbox passes the complete command through unchanged. It never supplies a
default command or adds full-allow flags.

Run `agentbox --help` for all options, `agentbox --print-settings` to inspect the
embedded SRT policy, and `agentbox --print-config` for a commented config
example. The default config path is `~/.config/agentbox.toml`. An existing config
is authoritative: credentials it omits are neither prompted for nor granted.

### Docker backend

When Lima is installed, agentbox maintains one shared Docker VM. Docker is
unrestricted inside that VM, while the VM has no host filesystem mounts and its
host-side Lima processes run in a separate, long-lived SRT sandbox. Containers
can use external networking, and published ports are reachable on the host.
Agentbox does not inject credentials into Docker automatically. All agentbox
invocations share the VM's containers, images, volumes, and build cache, so
invocations can inspect or disrupt one another. The first start downloads and
provisions the VM.

Manage the backend with:

```sh
agentbox --docker-start
agentbox --docker-status
agentbox --docker-stop
agentbox --docker-reset  # Deletes containers, images, volumes, and build cache.
```

Run agentbox on the host rather than from another sandbox. AWS SSO, for example,
may need to refresh files under `~/.aws/sso/cache` before agentbox exports its
temporary credentials.

### Datadog MCP

To authenticate the managed Datadog MCP server, put a narrowly scoped Service
Access Token in 1Password and reference it from the agentbox config:

```toml
[secrets]
DATADOG_SERVICE_ACCESS_TOKEN = "$DATADOG_SERVICE_ACCESS_TOKEN_REFERENCE"
```

Then configure the Codex harness to use the environment variable:

```toml
[mcp_servers.datadog]
url = "https://mcp.datadoghq.com/v1/mcp"
bearer_token_env_var = "DATADOG_SERVICE_ACCESS_TOKEN"
```

Use the MCP endpoint for your Datadog site if it is not US1.

## Development

The main security boundary is assembled in a few focused modules:

- [`src/cli.ts`](src/cli.ts) owns the trusted host-side launch sequence and the
  transition into SRT.
- [`src/policy.ts`](src/policy.ts) defines the default filesystem and host-service
  policy; [`src/seatbelt.ts`](src/seatbelt.ts) adds the macOS direct-IP rule.
- [`src/credentials.ts`](src/credentials.ts) resolves selected credentials
  without exposing their host-side stores.
- [`src/bazel.ts`](src/bazel.ts) keeps Bazel's persistent server inside one
  Agentbox launch.
- [`src/lima-backend.ts`](src/lima-backend.ts) provides Docker through an isolated
  and disposable VM rather than the host daemon.

Each special-purpose module starts with its problem, isolation approach, and
important caveats. The implementation should keep those headers current when a
boundary changes.

```sh
npm run format:check
npm run check
npm test
npm pack --dry-run
```

## License

Apache License 2.0. See [LICENSE](LICENSE).
