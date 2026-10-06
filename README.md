# agentbox

Agentbox is a small host-side wrapper around a persistent Linux VM managed by
[Lima](https://lima-vm.io/). It starts the VM, resolves selected credentials on
the host, and runs your command in the VM over SSH.

The VM is an ordinary development machine. Its source checkouts, build caches,
Docker images, and tmux sessions persist until you delete the VM. Agentbox does
not wrap or configure the development tools you run inside it.

## Install

Install Node.js 20.11 or newer, Lima 2.2 or newer, Git, OpenSSH, and
[crane](https://github.com/google/go-containerregistry/tree/main/cmd/crane) on
the host. Crane is only required when publishing guest Docker images. Then
install Agentbox from this checkout:

```sh
npm ci
npm run install:global
```

To install into a particular mise-managed Node version instead of the currently
active version:

```sh
npm run install:global -- --node 24.18.1
```

Agentbox runs on the host, not inside the VM.

## Configure and start

```sh
mkdir -p ~/.config/agentbox
agentbox --print-config > ~/.config/agentbox/config.toml
```

The useful parts of the host-only TOML are:

```toml
[vm]
ports = [3000]

[run]
aws_profile = "agentbox-readonly"
aws_region = "us-east-1"

[run.secrets]
GH_TOKEN = "op://Agentbox/GitHub/token"
SERVICE_API_KEY = "op://Agentbox/Service/token"
```

Credential values do not belong in this file. Authenticate the AWS and
1Password CLIs on the host.

```sh
agentbox vm config   # Preview the generated Lima configuration
agentbox vm start
agentbox vm status
```

The defaults give the VM 75% of the host's CPUs and RAM and a 200 GiB virtual
disk. Resource and port settings are applied when the VM is created. To edit an
existing VM, stop it and use Agentbox's dedicated Lima home:

```sh
agentbox vm stop
LIMA_HOME="$HOME/.local/share/agentbox/lima" limactl edit agentbox
agentbox vm start
```

Agentbox validates the stored configuration before launching a session.

## Work in the VM

```sh
agentbox -- bash -l
```

Commands start in the guest home directory:

```sh
agentbox -- docker ps
agentbox -- bash -lc 'cd ~/src/project && make test'
```

The guest has sudo, Docker, Compose, Git, Node, Python, and basic build tools.
Install project-specific tools normally inside the guest.

Copy a host file into the guest home, or provide a guest-relative or absolute
destination. Use `--recursive` for directories:

```sh
agentbox copy ./config.json
agentbox copy ./config.json src/project/config.json
agentbox copy --recursive ./fixtures src/project/
```

Copy from the guest by providing an explicit host destination. Existing host
files may be overwritten:

```sh
agentbox copy --from-guest build/output.tar ./output.tar
agentbox copy --from-guest --recursive build/reports ./reports
```

`agentbox cp` is an alias in either direction. Copies are explicit and do not
create a host mount.

Ghostty users should install its terminal definition in the VM once so keys and
screen editing work correctly:

```sh
infocmp -x xterm-ghostty | agentbox -- tic -x -
```

Add `-c PATH` to that Agentbox command when using a non-default configuration.

## Credentials

For each launch, Agentbox:

1. asks the host's `aws` CLI for temporary credentials from the configured
   profile;
2. reads configured `op://` references with the host's `op` CLI;
3. sends only those values to the requested guest process over SSH.

The host's credential files, 1Password session, SSH agent, Docker socket, and
other ambient credentials are not forwarded. AWS profiles must return temporary
credentials with a session token and expiration. Permissions are still enforced
by AWS, GitHub, and the other providers; Agentbox does not make a credential
read-only.

You can also select credentials on the command line:

```sh
agentbox run \
  -p agentbox-readonly \
  -s 'GH_TOKEN=op://Agentbox/GitHub/token' \
  -- bash -l
```

### tmux

A convenient long-lived workflow is to keep one or more named tmux sessions and
explicitly choose which one receives the credentials from an Agentbox launch:

```sh
agentbox tmux refresh dev
```

Agentbox resolves credentials on every launch. An existing tmux session,
however, has its own environment, and each shell and program inside it has a
separate copy. `agentbox tmux refresh SESSION` writes the credentials and
configured `[run.env]` values from that launch into only the named session,
clears values that were previously selected but are no longer present, and
attaches to it. Credential values are not put in tmux's global environment, so
other sessions keep their own values. No variable list is needed in
`.tmux.conf`. Existing shells still need to copy the refreshed session
environment into themselves.

Use a different Agentbox configuration or command-line credential selection
for each session when needed:

```sh
agentbox -c ~/.config/agentbox/work.toml tmux refresh work
agentbox -c ~/.config/agentbox/personal.toml tmux refresh personal
```

#### One-time setup

Add this helper to `~/.zshrc` inside the VM. It refreshes the current shell
directly and sends the same command to every other idle zsh or bash pane in the
current session:

```zsh
agentbox-refresh-tmux() {
  if [[ -z ${TMUX-} ]]; then
    print -u2 "Not inside tmux"
    return 1
  fi

  local current_pane=$TMUX_PANE
  local pane foreground
  local refreshed=0

  eval "$(command tmux show-environment -s)"
  (( ++refreshed ))

  while IFS='|' read -r pane foreground; do
    [[ "$pane" == "$current_pane" ]] && continue

    case "$foreground" in
      zsh|bash)
        command tmux send-keys -t "$pane" C-c \
          'eval "$(tmux show-environment -s)"' Enter
        (( ++refreshed ))
        ;;
      *)
        print -u2 "Skipped $pane ($foreground): restart it after refreshing its shell"
        ;;
    esac
  done < <(
    command tmux list-panes -s \
      -F '#{pane_id}|#{pane_current_command}'
  )

  print "Refreshed environment in $refreshed shell pane(s)"
}
```

Codex users should also add this alias to `~/.zshrc`. Running without the
long-lived daemon makes each Codex launch inherit the refreshed environment of
the shell that invoked it:

```zsh
alias codex='codex --no-daemon'
```

Load the helper into the current shell once:

```sh
source ~/.zshrc
```

#### Refresh credentials

1. Refresh or unlock the configured credential providers on the host if
   necessary.
2. From the host, run `agentbox tmux refresh SESSION`. Agentbox obtains fresh
   values, configures only the named tmux session to refresh every injected
   name, and attaches to it.
3. Once attached, run `agentbox-refresh-tmux`. New panes already inherit the
   updated values; the helper updates existing idle shell panes in the current
   session as well.

The helper skips panes with a foreground program because a running process's
environment cannot be changed externally. Stop that process, run
`agentbox-refresh-tmux` again after its shell prompt returns, then restart the
process. There is no need to recreate the tmux session or restart the VM. The
helper sends `C-c` to other idle shell panes, so it also clears any unfinished
command at their prompts.

## Ports

Configured ports are forwarded from host loopback to guest loopback, so a
service listening on port 3000 in the VM is available at
`http://localhost:3000` on the host.

Only one host process can own a port. If another service or Lima VM already uses
3000, free the port and restart Agentbox:

```sh
lsof -nP -iTCP:3000 -sTCP:LISTEN
limactl stop dev        # If the old default-home VM owns it
agentbox vm stop
agentbox vm start
```

Agentbox keeps its VM under `~/.local/share/agentbox/lima`. This is separate
from the instances shown by a normal `limactl list`, which uses Lima's default
home.

## Publish Docker images

Build and load an image into the guest Docker daemon with its complete registry
tag. From the host, publish that exact image using the host's registry
credentials:

```sh
agentbox docker publish registry.example.com/team/image:tag
```

Agentbox verifies that the exact tag exists in the guest, exports its image ID
over SSH to a private temporary host archive, and asks `crane` to push it to the
same reference. The archive is removed after success or failure. The host
Docker daemon is not required, and registry credentials, credential helpers,
and the host Docker socket are not sent into the VM.

Authenticate `crane` on the host before publishing. It uses the host's Docker
credential configuration and helpers, or credentials configured with
`crane auth login`.

## Move code with Git

Host directories are not mounted into the VM. Agentbox instead creates an empty
bare Git repository on the guest disk for returning commits to the host.

Create the exchange from a host checkout:

```sh
agentbox git init project
```

In the VM, clone the main repository normally and add the exchange as a second
remote:

```sh
gh auth setup-git
git clone https://github.com/your-org/your-repo.git ~/src/project
cd ~/src/project
git remote add exchange ~/.local/share/agentbox/exchange/project.git
git config remote.pushDefault exchange
```

`origin` remains the read-only source for fetches and pulls. A plain `git push`
goes to `exchange`:

```sh
# In the VM
git switch -c my-work origin/main
# Commit changes.
git push
```

From the host checkout, publish that branch directly to its normal `origin`:

```sh
agentbox git publish project my-work
```

This fetches the exchange branch and pushes it using the host's Git credentials,
without checking it out or sending write credentials into the VM.

To inspect the branch before publishing it, fetch the exchange manually. Its
branches appear under `agentbox/EXCHANGE/` without changing the current branch
or working tree:

```sh
agentbox git fetch project
git log --oneline HEAD..agentbox/project/my-work
git diff HEAD...agentbox/project/my-work
```

For a branch that does not yet exist locally, create it from the fetched ref and
then publish it using the host's normal GitHub credentials:

```sh
git switch -c my-work agentbox/project/my-work
git push -u origin my-work
```

If the local branch already exists, fast-forward it to the exchange version:

```sh
git switch my-work
git merge --ff-only agentbox/project/my-work
```

The guest's GitHub token should have read-only repository access. An explicit
`git push origin` still targets GitHub and should be rejected by GitHub; the
default push target is the local exchange. Only committed Git objects move
between the machines. If the host and exchange branches have diverged, inspect
the commits and reconcile them with the usual merge or rebase workflow.

## Isolation

The VM has no host mounts, SSH-agent forwarding, X11 forwarding, or host Docker
socket. It does have outbound networking, guest sudo, and its own Docker daemon.
Anything running in the VM can inspect guest state and retain credentials it
receives, so use provider-side scopes and separate VMs for separate trust
boundaries.

## Development

```sh
npm run check
npm test
npm run format:check
```

Apache License 2.0. See [LICENSE](LICENSE).
