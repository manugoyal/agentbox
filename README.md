# agentbox

Agentbox gives you a persistent Linux development VM with selected credentials
and a Git exchange. Run the CLI on your host, open a shell in the VM, and use
ordinary development commands there: Docker, Compose, Bazel, and your project's
own setup scripts.

The VM is the isolation boundary. Its entire filesystem belongs to the guest;
no host directories are mounted into it. Source checkouts, build caches, Docker
images, and volumes live on the VM's disk and persist between shell sessions.

```text
Host                                  Linux VM
  Lima manages resources and disk       shell + development tools
  1Password / AWS authenticate here     selected credentials in process env
  Git checkout                          Git checkout + build caches + Docker
       └── host-initiated SSH ────────►  bare Git exchange repository
```

## Start a VM

Install Node.js 20.11 or newer, [Lima](https://lima-vm.io/docs/installation/)
2.2 or newer, Git, and OpenSSH on the host. From a host checkout of this repo:

```sh
npm ci
npm run install:global

mkdir -p ~/.config/agentbox
agentbox --print-config > ~/.config/agentbox/config.toml
```

Edit the generated host configuration. Resource defaults allocate 75% of the
host's logical CPUs and RAM, with a 200 GiB virtual disk. Only the listed TCP
ports are forwarded to the host's loopback interface; an empty list exposes no
application ports.

```toml
[vm]
name = "agentbox"
cpu_percent = 75
memory_percent = 75
disk_gib = 200
ports = [3000, 8000]
```

```sh
agentbox vm config    # Preview the generated Lima YAML
agentbox vm start     # Create and provision if needed, then start
agentbox -- bash -l   # Open a shell in the guest's home directory
```

The guest runs Ubuntu with basic build tools, Python, Node, Git, Docker,
Compose, and Buildx. Install project-specific tool versions inside the VM.
Guest sudo and the guest Docker daemon are available; containers can use guest
files through ordinary bind mounts. Bazel and other build tools use their usual
persistent guest caches. No cache-sharing wrapper is needed between sessions.

CPU allocation rounds down to whole cores, with a minimum of one. RAM rounds
down to 256 MiB and must be at least 1 GiB. macOS defaults to Lima's VZ driver;
Linux defaults to QEMU. Use `--cpu-percent`, `--memory-percent`, `--disk-gib`,
and `--ports` to override the configuration at creation time. `vm config` also
accepts `--host-cpus`, `--host-memory-gib`, and `--vm-type vz|qemu` for previews
on another machine.

Resource and port settings apply when **creating** the VM. Changing the TOML
does not reconfigure an existing instance. See [VM maintenance](vm/README.md)
for editing an existing VM.

## Give a session selected credentials

Authenticate with 1Password and AWS **on the host**. Add references to the host
configuration; keep credential values out of the file:

```toml
[run]
aws_profile = "agentbox-readonly"
aws_region = "us-east-1"

[run.secrets]
GH_TOKEN = "op://Agentbox/GitHub/token"
BRAINTRUST_API_KEY = "op://Agentbox/Braintrust/token"

[run.env]
# Optional ordinary environment settings for the guest process.
BRAINTRUST_APP_URL = "http://localhost:3000"
```

```sh
agentbox -- bash -l
```

The launcher uses the host's `op read` and `aws configure export-credentials`
commands. Only the selected values enter the guest process environment. The
host's 1Password session, AWS profile files, login caches, SSH agent, and other
ambient credentials stay on the host. With no credential configuration, neither
`op` nor `aws` is required.

A launched shell and its children inherit those values. Normal SSH handles the
terminal, resizing, signals, standard input, and exit status. Shells start in
the guest home directory; use `cd` normally. Individual commands also work:

```sh
agentbox -- docker ps
agentbox -- bash -lc 'cd ~/braintrust/braintrust && make develop'
agentbox run -p agentbox-readonly -s 'GH_TOKEN=op://Agentbox/GitHub/token' -- bash -l
```

Read-only permissions must be enforced by each service. Agentbox requires the
AWS profile to return a session token and future expiration, rejecting static
AWS credentials. It does not inspect IAM policies. Stored GitHub, Braintrust,
and other 1Password tokens retain their existing permissions and lifetime;
reading a token from 1Password does not restrict it or make it temporary.
Configure the permitted resources, operations, and expiry when issuing them.
See the [AWS credential export reference](https://docs.aws.amazon.com/cli/latest/reference/configure/export-credentials.html),
[1Password read reference](https://www.1password.dev/cli/reference/commands/read),
and [GitHub token controls](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

There is no automatic refresh. Launch a new session after refreshing host
credentials when necessary. Closing a shell does not revoke provider tokens or
remove credentials from detached descendants. Existing tmux servers and other
long-lived processes retain their own environments.

## Exchange code with the host

Each exchange is an ordinary bare Git repository **inside the VM**. The host
connects to it using Lima's SSH identity; guest checkouts access it by local
path. The guest needs no host login or host filesystem access.

From an existing checkout on the host:

```sh
cd ~/braintrust/braintrust
agentbox git init braintrust
agentbox git push braintrust HEAD:refs/heads/main
```

Inside the guest shell:

```sh
mkdir -p ~/braintrust
git clone ~/.local/share/agentbox/exchange/braintrust.git ~/braintrust/braintrust
cd ~/braintrust/braintrust
git switch -c my-work
# Edit, build, and test. Set your Git author identity in the VM if needed.
git add path/to/changed-file
git commit -m 'Describe the change'
git push origin my-work
```

Back in the host checkout:

```sh
agentbox git fetch braintrust
git diff HEAD...refs/remotes/agentbox/braintrust/my-work
# After review, incorporate the commits using your normal Git workflow.
```

Fetching updates `refs/remotes/agentbox/braintrust/*`; it leaves the host's
working tree and current branch alone. Agentbox disables local Git hooks during
its exchange commands and does not fetch submodules automatically. It does not
commit files for you or transfer untracked and uncommitted work. Guest commits
remain untrusted input until reviewed, including build scripts and hooks.

## What the boundary protects

- **Host files and host authority:** no shared host directories, file-copy rules,
  SSH-agent or X11 forwarding, host Docker socket, or inherited proxy environment.
  Agentbox uses its own Lima configuration directory and rejects global Lima
  templates that could add sharing. It checks the stored VM configuration before
  starting or launching a credential session.
- **External services:** the VM receives only explicitly selected credentials.
  Provider permissions determine what those credentials can do. Read-only access
  still allows reading and exporting everything the credential can access.
- **VM resources:** CPU, memory, and virtual disk capacity bound the guest's
  allocation. All guest programs share that allocation and the same trust domain.

A program with guest access can modify the VM, inspect other guest state, use
Docker or sudo, and retain credentials it receives. Session environment scoping
is not secrecy from other guest processes or guest root. Keep broad credentials
out of the guest, including any credentials saved by earlier development work.
Use a separate VM when workloads need separate trust boundaries.

Guest networking remains available, including possible host and LAN access.
Explicit localhost port forwarding controls publication of guest services; it is
not an outbound firewall. Lima, SSH, the hypervisor, and host network services
remain part of the boundary. Keep host and guest software updated.

Credential handoff travels over SSH into a private file in guest `/dev/shm`, then
is read and unlinked before executing the requested command. This preserves a
normal SSH terminal without putting secret values in command arguments. An
unclaimed handoff becomes unusable after five minutes and is removed by the next
launch or reboot; normal completion also attempts cleanup. The VM's memory and
any swap or snapshots must be treated as containing guest secrets.

## Development

```sh
npm run check
npm test
npm run format:check
npm pack --dry-run
```

The tests cover configuration and lifecycle behavior plus real local SSH
sessions for credential selection, binary stdin, exact arguments, exit status,
interactive job control, terminal resizing, and Git exchange. SSH tests need
Linux with `/usr/sbin/sshd` and skip elsewhere. Credentials are synthetic and the
Lima lifecycle is mocked; these tests do not boot a VM.

The generated configuration has also passed Lima 2.2 validation from an Ubuntu
ARM64 guest. Creating and booting the new VM, provisioning, and host port
forwarding still need end-to-end testing on the host. See [the validation
plan](vm/PLAN.md).

Apache License 2.0. See [LICENSE](LICENSE).
