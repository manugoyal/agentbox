# agentbox

`agentbox` runs an explicitly named command inside [Anthropic Sandbox Runtime
(`srt`)](https://github.com/anthropic-experimental/sandbox-runtime). It is meant
for tools such as coding agents that are most useful in full-allow mode: the tool
can operate freely within the sandbox while `srt` limits its filesystem and
network access.

The script starts with a small allowlist of host environment variables. It can
also export temporary AWS credentials and resolve 1Password references on the
host before launching the sandbox, so the child never needs access to `~/.aws`
or the 1Password client.

## Prerequisites

Required:

- macOS or Linux. The embedded policy is currently tailored to macOS; review it
  before relying on it elsewhere.
- [`uv`](https://docs.astral.sh/uv/getting-started/installation/). It supplies
  the Python 3.11+ runtime declared by the script, so a separate Python install
  is not required.
- Node.js and npm, then Sandbox Runtime:

  ```sh
  npm install -g @anthropic-ai/sandbox-runtime
  ```

- The command you want to run, such as Claude Code, Codex, or a shell.

Optional:

- [AWS CLI
  v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
  when using `--profile` or `aws_profile`.
- [1Password CLI](https://www.1password.dev/cli/get-started) when using
  `--secret` or the `[secrets]` config table. `op` must be signed in on the host.

Make the script executable if needed, then invoke it directly or place it on
your `PATH`:

```sh
chmod +x agentbox
./agentbox -- bash
```

## Usage

A command is always required and should follow `--`:

```sh
./agentbox -- bash
./agentbox -y -- claude --dangerously-skip-permissions
./agentbox -p development-readonly -- aws sts get-caller-identity
./agentbox -s 'GH_TOKEN=$GH_TOKEN_REFERENCE' -- gh repo view
```

`agentbox` does not add, remove, or rewrite child arguments. Include any
full-allow option required by your agent in the command you supply.

### Datadog MCP

The embedded policy allows Datadog's commercial and government sites. To give
the managed Datadog MCP server a Service Access Token, add its 1Password
reference to the agentbox config:

```toml
[secrets]
DATADOG_SERVICE_ACCESS_TOKEN = "$DATADOG_SERVICE_ACCESS_TOKEN_REFERENCE"
```

Then configure Codex to use that environment variable as the remote server's
bearer token in `~/.codex/config.toml`:

```toml
[mcp_servers.datadog]
url = "https://mcp.datadoghq.com/v1/mcp"
bearer_token_env_var = "DATADOG_SERVICE_ACCESS_TOKEN"
```

Create the service account and token with only the Datadog roles and scopes the
agent needs. Use the endpoint for your Datadog site if it is not US1.

Run `./agentbox --help` for all options, `./agentbox --print-settings` to inspect
the embedded `srt` policy, and `./agentbox --print-config` for a commented TOML
config example. The default config path is `~/.config/agentbox.toml`; an existing
config is authoritative, so omitted credentials are not prompted for or granted.

The embedded policy allows writes to the working tree and selected tool/cache
directories, blocks writes to agent settings and Git hooks, and limits network
access to an explicit domain list. Review the policy and the permissions of any
credentials you inject: full-allow mode is only as safe as those boundaries.
It deliberately gives the sandbox read/write access to `~/.claude` and
`~/.codex` so those harnesses can reuse their existing login and runtime state;
their configuration and hook files remain read-only.

Run `agentbox` on the host rather than from another sandbox. In particular, AWS
SSO may need to refresh files under `~/.aws/sso/cache` before temporary
credentials can be exported.

## License

Apache License 2.0. See [LICENSE](LICENSE).
