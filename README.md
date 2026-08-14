# agentbox

`agentbox` runs an explicitly named command inside [Anthropic Sandbox Runtime
(SRT)](https://github.com/anthropic-experimental/sandbox-runtime). It is designed
for coding agents that are most useful in full-allow mode: the agent can work
freely inside the sandbox while SRT limits the files and network destinations it
can reach.

Agentbox passes through a small host-environment allowlist. It can also exchange
an AWS profile for temporary credentials and resolve 1Password references on the
host, so the sandbox never needs access to `~/.aws` or the 1Password client.

## Prerequisites

Agentbox requires Node.js 20.11 or newer and the command you intend to run. SRT
is installed automatically as an npm dependency; do not install it separately.

On Linux, SRT also requires `bubblewrap`, `socat`, and `ripgrep`. The embedded
policy is primarily exercised on macOS, so review it before relying on another
platform.

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

The embedded policy restricts filesystem access and uses one explicit network
allowlist; unmatched destinations are denied. Review the policy and the scope of
any credentials you inject, because full-allow mode is only as safe as those
boundaries. On macOS, agentbox runs Bazel in batch mode so the build itself stays
inside the sandbox while its on-disk caches remain reusable.

When Lima is installed, agentbox maintains one shared Docker VM. Docker is
unrestricted inside that VM, while the VM has no host filesystem mounts and its
Lima hostagent and network run in a separate, long-lived SRT sandbox. Containers
have no direct external network access; image pulls use the same explicit domain
allowlist as other agentbox tools. Agentbox does not inject credentials into
Docker automatically. All agentbox invocations share the VM's containers,
images, volumes, and build cache, so concurrent invocations can interfere with
one another. The first start downloads and provisions the VM.

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

```sh
npm run format:check
npm run check
npm test
npm pack --dry-run
```

## License

Apache License 2.0. See [LICENSE](LICENSE).
