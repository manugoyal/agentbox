# VM maintenance

Agentbox's guest is a persistent Ubuntu development machine. The host CLI
combines [`ubuntu.yaml`](ubuntu.yaml) with resource and port settings to produce
a concrete Lima configuration. See the [main README](../README.md) for setup,
credential sessions, and Git exchange.

## Lifecycle and storage

Run these commands on the host:

```sh
agentbox vm start
agentbox vm status
agentbox vm stop
```

Stopping retains the VM disk, repositories, build caches, Docker images, and
volumes. Rebooting does not preserve running processes. Push committed work to
the host and back up the VM separately if uncommitted work matters; the bare
exchange repository resides on the same guest disk as your checkouts.

The default Lima home is `~/.local/share/agentbox/lima`, separate from other Lima
instances and their global configuration. Override it with a top-level
`lima_home` in the host TOML if necessary. A dedicated directory without global
`default.yaml`, `override.yaml`, or `base.yaml` files is required because Lima
merges these settings with instance configuration.

For direct Lima maintenance, use that directory explicitly:

```sh
export LIMA_HOME="$HOME/.local/share/agentbox/lima"
limactl list
limactl stop agentbox
limactl edit agentbox
limactl start agentbox
```

Replace `agentbox` with your configured VM name. The TOML resource settings are
creation defaults: edits to them do not resize an existing instance. Use Lima's
editor while stopped to change the instance's CPU, memory, or forwarding rules,
subject to the selected driver's capabilities. Keep `mounts: []`,
`copyToHost: []`, and the other sharing restrictions intact. Agentbox refuses
credential sessions when the stored configuration violates those restrictions.

An explicit forwarded port uses the following rule before the catch-all ignore
rule; keep host bindings on loopback:

```yaml
portForwards:
  - guestPort: 3000
    hostPort: 3000
    guestIP: 127.0.0.1
    hostIP: 127.0.0.1
    proto: tcp
    static: true
  - guestIP: 0.0.0.0
    proto: any
    ignore: true
```

See Lima's [configuration](https://lima-vm.io/docs/config/),
[mount](https://lima-vm.io/docs/config/mount/), and
[port-forwarding](https://lima-vm.io/docs/config/port/) documentation.

## Guest provisioning

The template pins official Ubuntu cloud-image URLs and SHA-256 hashes for
native ARM64 and x86-64 guests. Initial provisioning updates packages and installs
ordinary terminal, build, and Docker tools. A marker prevents repeating package
setup on every start. Keep the guest updated afterward:

```sh
sudo apt update
sudo apt upgrade
```

Reboot when required by kernel and system updates. Dated Ubuntu images may
expire from the download server; update URLs and verified hashes together.
Package repositories provide current packages, so the installation is not a
bit-for-bit reproducible environment.

The guest account has normal guest sudo privileges and Docker group membership.
Docker uses the guest's system daemon and persistent `/var/lib/docker`. Container
bind mounts refer to guest files. Project-specific runtimes and build tools are
installed using the project's normal instructions.

[`session.py`](session.py) is sent over SSH by the host launcher. It validates a
small request, stages selected environment values in private guest tmpfs, and
executes the requested program in the guest home directory. Agentbox itself does
not need to be installed inside the guest. The host-side CLI and authentication
tools stay on the host.

## Validation status

Development so far ran inside an existing Ubuntu ARM64 Lima guest. Generated
YAML passed the real Lima 2.2 validator. Local OpenSSH integration tests exercise
credential handoff, interactive terminals, and Git transfer. They do not verify
VM boot, cloud-init provisioning, or host port forwarding. Those checks require
a session on the host; see [`PLAN.md`](PLAN.md).
