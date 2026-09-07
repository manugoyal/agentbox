# Linux development workstation

`ubuntu.yaml` is a standalone Lima template, not an agentbox runtime backend.
It creates a persistent, terminal-only Ubuntu 26.04 LTS workstation. The guest
has generic development tools, but no repositories, credentials, agents, Docker
daemon, or project-specific build configuration.

## Template versus machine configuration

The shared template describes the guest OS and baseline setup. It deliberately
does not fix CPU count, RAM, disk size, VM driver, host username, or host paths.
It supports native ARM64 and x86-64 guests. Choose resources at creation time;
Lima stores the resolved configuration with each instance. Reusing this
template does not share disks or other state between instances.

Example for a 16 GiB Apple Silicon Mac running macOS 26 or newer, dedicating
most resources to development:

```sh
limactl create --name=dev \
  --vm-type=vz --network=vzNAT \
  --cpus=8 --memory=12 --disk=200 \
  --set '.vmOpts.vz.diskImageFormat = "asif"' \
  vm/ubuntu.yaml
limactl start dev
limactl shell dev
```

On another machine, change the CPU, RAM, and disk arguments. Keep enough RAM
for the host OS to avoid swapping. ASIF requires macOS 26+; omit the `--set`
argument on older Macs to use Lima's default raw disk image. VZ and vzNAT are
Mac-specific choices, not requirements of the template. Other Lima hosts can
select their supported driver/network instead; those hosts are not yet tested.

## Daily use

Keep checkouts in `~/src` inside Linux; all source files, caches, and container
storage should remain on the guest's Linux filesystem. Connect with
`limactl shell dev`, then use `tmux new-session -A -s work` for a reconnectable
terminal session. Standard SSH also works with Lima's generated SSH config:

```sh
ssh -F "$HOME/.lima/dev/ssh.config" lima-dev
# Explicit example tunnel for a server listening on guest localhost:3000:
ssh -F "$HOME/.lima/dev/ssh.config" -N -L 3000:localhost:3000 lima-dev
```

The commands above assume Lima's default configuration directory. If you
customize `LIMA_HOME`, locate the generated config with
`limactl list --format '{{.SSHConfigFile}}' dev`.

```sh
limactl autostart enable dev   # Start in the background at Mac login.
limactl stop dev              # Clean shutdown; disk data persists.
limactl start dev
```

The initial setup updates Ubuntu packages once. Maintain guest security
updates afterward and reboot after kernel updates. A Mac reboot does not
preserve guest processes. Back up uncommitted work as well as pushing Git
commits; a VM disk is not itself a backup.

## Boundaries

- No Mac filesystem mounts, forwarded SSH agent, X11, or copied host credentials.
- Automatic guest-port publication is disabled except Lima's SSH connection.
- Guest networking remains available, including potential host/LAN reachability.
  NAT is not a host-access firewall. The host DNS resolver and Lima guest agent
  remain enabled for network changes and clock synchronization.
- The Linux developer account retains Lima's default guest-only sudo access.
  This is a workstation, **not a configured agent jail**. Agentbox policy and
  any agent-accessible Docker runtime require separate setup inside Linux.
- The template installs no container daemon and exposes no host Docker socket.

## Reproducibility

The official Ubuntu cloud-image URLs and SHA-256 hashes are pinned. Package
updates follow Ubuntu's repositories, so provisioning is repeatable but not a
bit-for-bit reproducible software environment. Ubuntu eventually expires dated
cloud images; refresh URLs and verified hashes together when necessary.

An existing instance has its own copy of the template. Editing this repository
does not change an already-created VM. Inspect its configuration under the
instance's Lima directory, or use `limactl edit dev` while it is stopped.
