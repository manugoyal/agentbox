# agentbox

agentbox runs a command and its descendants in a lightweight Linux sandbox.
It gives coding agents, build tools, and scripts a writable checkout while
restricting their access to the rest of your workstation. You choose which
additional files, credentials, and network access each launch receives.

```sh
agentbox -y -- bash
agentbox -y --network host -- your-agent
```

The sandbox is built with [Bubblewrap](https://github.com/containers/bubblewrap)
and Linux namespaces. Ordinary launches execute the command directly inside
those namespaces and require no background service. Optional Docker support
adds a private daemon inside the sandbox.

## How the sandbox works

Each launch starts with an empty filesystem view. Agentbox mounts the tools and
data the command needs, creates private working directories, and starts the
command with a selected environment. The kernel enforces the resulting access
rules for the command and its descendants.

With the default configuration:

| Resource                       | Access inside the sandbox                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| Current checkout               | Read and write; changes persist on the workstation.                                   |
| System tools and libraries     | Read-only, including `/usr` and the Node installation running agentbox.               |
| System configuration           | A small read-only selection, including certificates, DNS, and user/group information. |
| Home and temporary directories | Fresh, private directories; contents disappear when the launch ends.                  |
| Other workstation files        | Hidden unless explicitly granted.                                                     |
| Processes and IPC              | Private namespaces for the sandbox's process tree and IPC resources.                  |
| Network                        | Private loopback; no external connectivity.                                           |
| Credentials                    | Only explicitly selected credentials are injected.                                    |
| Docker                         | Disabled unless requested.                                                            |
| Aggregate resource limits      | Unset unless configured.                                                              |

### Filesystem and privilege isolation

Mount namespaces determine which paths exist inside the sandbox. A command can
edit its checkout, but your home directory, sibling projects, and workstation
sockets are outside its filesystem view unless you grant access to them. The
private home appears at your usual home path, so programs can create their
normal configuration and cache directories without writing to your real home.

Ordinary launches drop Linux capabilities, prevent privilege gains through
setuid programs, and disable further user namespaces. A process cannot turn a
read-only mount into a writable one or obtain workstation root privileges just
by executing a privileged binary. Docker uses an additional nested namespace
arrangement described below.

Agentbox protects its launcher configuration and installed runtime paths within
writable grants using read-only mounts. It also anchors their parent directories
to prevent replacing protected paths by renaming an ancestor. Configuration
layouts that cannot be protected safely are rejected.

### Process isolation and lifetime

Private PID and `/proc` namespaces restrict process visibility to the sandbox.
Separate IPC, hostname, and cgroup namespaces isolate the corresponding system
views. The command receives its original arguments and standard input/output;
its exit status is returned to the caller.

The process tree belongs to one launch. When the launch exits or is killed,
remaining descendants are terminated. Writes to granted directories persist;
private home and temporary data are discarded. If namespace setup or a requested
restriction fails, the launch fails without executing the command unsandboxed.

### What the boundary covers

The sandbox limits access to workstation resources. It shares the workstation's
Linux kernel, so its security depends on that kernel, Bubblewrap, the launcher,
and the installed tools used during setup. Kernel vulnerabilities are outside
this isolation boundary.

A writable grant gives the command authority to modify or delete its contents.
A readable grant exposes everything within it, including any credentials,
sockets, nested mounts, or hard-link aliases. Network access allows the command
to transmit readable data, and injected credentials retain their service-side
permissions. Choose grants and credentials with those consequences in mind.

The sandbox also cannot make generated files trustworthy. Code or cached build
results written during a launch can affect a later program that consumes them.
Use separate checkouts and caches for workloads with different levels of trust.

## Install and run

Requires Linux, Node.js 20.11+, and Bubblewrap with user namespace support.
Run as an ordinary user. From a clone of this repository on Ubuntu:

```sh
sudo apt install bubblewrap
npm ci
npm run install:global
```

Launch from the checkout you want the command to work in:

```sh
agentbox -- bash
agentbox -y -- ./scripts/test.sh
agentbox -y --network host -- your-agent
```

`--` separates agentbox options from the command and its arguments. Interactive
launches show the selected access and ask for confirmation. `-y` skips that
confirmation and is required for noninteractive use. Credentials are selected
through configuration or flags; omitted credentials are not prompted for.

Terminal input is passed through. Interactive shells currently lack job control
because the sandbox starts a new session.

You can run agentbox inside a Linux VM. In this documentation, **workstation**
means the Linux system launching agentbox; `--network host` refers to that
system's network. The [`vm/`](vm/) directory contains a separate Lima workstation
template.

## Configure access

Agentbox reads `~/.config/agentbox.toml`. Use `--config PATH` to select another
file, or `--print-config` to print a commented example. Every setting is optional.

```toml
network = "none"

[filesystem]
read_only = ["../shared-docs", "/opt/my-toolchain"]
read_write = ["../related-checkout", "~/.cache/my-build-cache"]

[limits]
memory = "8G"
tasks = 512
cpu = 400

[env]
SERVICE_ORG = "example"
```

### Files and tools

Grant paths must already exist. Relative paths resolve from the launch directory;
`~/` expands to your Linux home. Symlinks are resolved and their canonical paths
are mounted. Read-only children override writable parents; a write grant beneath
an explicit read-only grant is rejected.

Launch from a checkout directory. Whole-home write grants, writable system toolchains,
and grants exposing `/proc`, `/sys`, `/dev`, or `/run` are rejected. Keep launcher
configuration outside writable checkouts when possible.

System tools and the Node installation running agentbox are available by default.
Tools installed elsewhere need a read-only grant and, if necessary, an `[env]`
`PATH` containing their actual installation directory. Agentbox preserves the
workstation's `PATH` for lookup, but that does not make hidden paths accessible.
Shell startup files and version-manager configuration are not imported.

Grant individual cache or application-state directories when you need
persistence. This includes any agent configuration you want the command to use;
agentbox does not automatically expose application state from your home. A grant
also exposes any secrets and service sockets stored in that directory.

Git worktrees automatically receive access to their common Git metadata. This
allows normal Git operations while keeping sibling checkout files hidden, but
the worktrees still share repository state. Use separate clones when that shared
write access is inappropriate.

### Network

`--network none` is the default. Processes within the sandbox can communicate
through loopback TCP and local Unix sockets. They cannot use the workstation's
network or its abstract Unix sockets.

`--network host` shares the workstation network for ordinary launches. It allows
internet, localhost, LAN, and abstract Unix socket access, with no domain
filtering. Workstation services become reachable according to their own access
controls. Filesystem sockets remain subject to filesystem grants.

Docker launches always have a separate network namespace. With `--network host`,
`slirp4netns` provides outbound access; its host-loopback shortcut is blocked,
but workstation-address and LAN services remain reachable. Docker-published
ports are reachable **inside the sandbox**, without automatically becoming
reachable from the workstation or a VM's physical host. With `--network none`,
Docker can use loaded images and local container networks.

### Environment and credentials

The command receives a small environment for tool lookup, locale, terminal use,
and its private home and temporary paths. Ambient tokens, SSH agents, Docker
endpoints, and proxy settings are not inherited. Add ordinary string values in
`[env]` and select credentials through AWS profiles or 1Password references:

```sh
agentbox -y --network host -p development-readonly -- aws sts get-caller-identity
agentbox -y --network host -s 'SERVICE_TOKEN=op://Development/service/token' -- ./script
```

The same selections can be configured in TOML:

```toml
aws_profile = "development-readonly"
aws_region = "us-east-1"

[secrets]
SERVICE_TOKEN = "$SERVICE_TOKEN_REFERENCE"
```

A secret reference can be an `op://` path or `$VAR` naming a workstation
environment variable that contains that path. AWS CLI and the 1Password `op`
CLI run outside the sandbox to resolve the selected credentials. The resulting
values are injected into the command's environment through a private pipe,
keeping them out of sandbox setup arguments and systemd unit properties.

The receiving process can read and use those credentials. Restrict their
permissions at the service, and keep secret values out of the plain `[env]`
configuration table.

### Resource limits

Optional `[limits]` settings apply to the entire process tree, including Docker
and its containers. They use a transient systemd user scope and require an active
systemd user manager.

- `memory` accepts a byte count or K/M/G/T suffix, and disables swapping for the scope.
- `tasks` limits the number of processes and threads combined.
- `cpu` is a percentage: `100` permits one CPU's worth of time; `400` permits four.

No aggregate quotas are applied without these settings. If a requested limit
cannot be applied, the launch fails.

### JSON policy

`--settings PATH` optionally selects an agentbox JSON policy as the base for a
launch. `--print-settings` prints the default policy. TOML filesystem grants
extend that base; TOML network, Docker, and individual limit settings override
it. CLI options take precedence over the corresponding TOML settings. Both file
formats reject unknown settings.

## Share build caches

A cache persists when its directory is explicitly granted read-write access.
For Bazel, create shared repository and disk cache directories:

```sh
mkdir -p ~/.cache/agentbox/bazel/repository ~/.cache/agentbox/bazel/disk
```

Add those directories to your TOML configuration:

```toml
[filesystem]
read_write = [
  "~/.cache/agentbox/bazel/repository",
  "~/.cache/agentbox/bazel/disk",
]
```

Run an accessible Bazel installation with its standard repository and
[disk cache](https://bazel.build/remote/caching#disk-cache) options:

```sh
agentbox -y --network host -- bazel --output_user_root=/tmp/bazel build \
  --repository_cache="$HOME/.cache/agentbox/bazel/repository" \
  --disk_cache="$HOME/.cache/agentbox/bazel/disk" //...
```

The cache directories persist across launches. The Bazel server and output
directory live in the launch's private `/tmp`, keeping their lifecycle within
the sandbox. Share cache directories only among trusted writers; keep server
and output directories private to each launch.

Bazel can use `processwrapper-sandbox` inside an ordinary agentbox launch, where
further user namespaces are disabled. The outer sandbox confines the entire
build process tree. Bazel receives the command and configuration you supply.

## Run Docker inside the sandbox

`--docker` starts a private Docker daemon and points the command's Docker client
at its Unix socket. The daemon, images, containers, and socket belong to that
launch. Container bind mounts resolve against the sandbox's filesystem view,
so containers receive only paths that are already available within the sandbox.

```sh
agentbox -y --docker --network host -- docker run --rm alpine echo hello
agentbox -y --docker --network host -- bash
```

Inside the shell, Docker commands use the private daemon. Install Docker's
buildx or Compose plugins separately if your workflow needs them.

### Docker isolation

Docker needs namespace capabilities to create containers, mounts, and networks.
Agentbox first establishes the outer filesystem boundary, then enters a nested
user namespace before starting the daemon or your command. Capabilities in the
inner namespace cannot make inherited read-only mounts writable.

UID 0 inside the namespace maps to your ordinary Linux account; other IDs map
to your subordinate-ID allocation. The daemon can administer the sandbox's
container environment without workstation root privileges. Its cgroup access
is limited to a delegated subtree, with configured aggregate limits enforced
by an enclosing cgroup outside its control.

The daemon and containers terminate with the launch. Docker mode exposes
read-only kernel/device metadata and the delegated cgroup subtree needed by
container runtimes, adding kernel and runtime surface to the ordinary sandbox.
Requests for unavailable privileges can fail; for example, `--privileged` may
be unable to mount writable sysfs.

### Docker setup

Docker mode requires `dockerd`, the Docker client, containerd/runc, `uidmap`,
`slirp4netns`, util-linux, and a systemd user manager with cgroup v2 delegation.
Your account needs at least 65,535 subordinate IDs in both `/etc/subuid` and
`/etc/subgid`.

On an Ubuntu workstation dedicated to sandboxed Docker, prevent system daemons
from starting before installing the binaries:

```sh
sudo systemctl mask docker.service docker.socket containerd.service
sudo apt install docker.io uidmap slirp4netns
```

If you use an existing workstation Docker service, keep its service configuration.
Agentbox starts its own daemon for each launch and does not need access to the
workstation daemon's socket.

On Ubuntu with AppArmor user-namespace restrictions, install the application
entrypoint and profile from this repository:

```sh
sudo install -D -m 755 linux/agentbox-bwrap /usr/local/libexec/agentbox-bwrap
sudo install -m 644 linux/agentbox-docker.apparmor /etc/apparmor.d/agentbox-docker
sudo apparmor_parser -r /etc/apparmor.d/agentbox-docker
```

The profile permits the namespace capabilities required by container runtimes
through this entrypoint. Filesystem and process restrictions are enforced by
the sandbox's namespaces; the profile itself grants broad permissions within
that boundary. The system Bubblewrap profile and user-namespace sysctl remain
unchanged.

### Persistent Docker data

Images and volumes are ephemeral by default. To retain them, create a dedicated
directory and set `docker_data` at the top level of your TOML configuration:

```sh
mkdir -p ~/.cache/agentbox/docker
```

```toml
docker_data = "~/.cache/agentbox/docker"
```

The directory is granted only when Docker mode is enabled. Use separate data
directories for concurrent launches, since Docker locks its data directory.
Container-created files can be owned by subordinate IDs; maintain them through
the sandbox's daemon. Persistent images and volumes carry data and changes
between launches, just like other shared writable directories.

## Development and validation

For local development, use `npm run build` and `node dist/cli.js`, or `npm link`.
The global installation is an independent snapshot; reinstall after changing
the source if you use that installation.

```sh
npm run check
npm test
npm run test:docker  # Requires Docker prerequisites and static /usr/bin/busybox
npm run format:check
npm pack --dry-run
```

Core integration tests launch real sandboxes and check filesystem, process,
network, environment, cleanup, and resource-limit behavior. Docker tests import
a local BusyBox image and exercise container execution and containment without
registry access. Ubuntu 26.04.1 ARM64, Bubblewrap 0.11.1, and Node 24 have been
tested. See [`linux/VALIDATION.md`](linux/VALIDATION.md) for the tested environment,
Bazel cache results, and validation limits.

## License

Apache License 2.0. See [LICENSE](LICENSE).
