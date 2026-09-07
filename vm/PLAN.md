# Resume plan: a persistent Linux development workstation

## September 10 implementation update

Development has resumed inside the existing Ubuntu Lima workstation. Agentbox
now implements the separate Linux process-jail task described near the end of
this handoff. It uses Bubblewrap directly for ordinary processes, with explicit
filesystem and credential grants. Optional Docker runs a daemon inside nested
namespaces; Bazel shares only explicitly granted cache directories, without a
shim. See [the current README](../README.md) and
[Linux validation results](../linux/VALIDATION.md).

The original workstation bootstrap plan below remains a historical handoff.
This implementation did not re-create the VM or validate its Lima template,
backups, autostart, sleep/wake, or other bootstrap acceptance criteria.

## Status and instruction to the next session

This is a handoff, not a completed VM installation. The user explicitly stopped
setup and asked for the full plan here so work can resume on another machine.
**Do not assume that a VM exists, that provisioning succeeded, or that the
current template has been tested.**

As checked on September 6, 2026:

- `vm/ubuntu.yaml` and `vm/README.md` have been added to this repository.
- `ubuntu.yaml` is a draft generic template. It has not been boot-tested, and
  there is no confirmed successful validation result from the interrupted run.
- `limactl list --json` reported no instances. The original Mac's Lima directory
  contained only its pre-existing `_config` directory.
- No VM creation, boot, package provisioning, performance test, autostart setup,
  repository migration, or credential migration was completed.
- No existing agentbox implementation was changed for this architecture.
- The existing `vm/README.md` and `vm/ubuntu.yaml` were already staged at handoff.
  Preserve the user's index/worktree; do not commit or restage without direction.

Resume by reviewing these files and inspecting the new host, not by assuming
that interrupted commands ran. Until the user resumes implementation, only
documentation work is requested.

## User requirements and decisions

1. Move development into one persistent Linux VM. macOS is the physical host
   and terminal client, not the place where source checkouts and builds live.
2. No Linux GUI is needed. Terminal/SSH access is sufficient.
3. Prioritize robust, low-overhead, high-performance operation. When working in
   the VM, the user expects to devote nearly all machine resources to it.
4. Prefer Ubuntu and Lima. Lima is already installed on the original Mac.
5. No Mac/Linux repository synchronization, Mac home mounts, forwarded SSH
   agents, ambient credentials, or host Docker socket sharing.
6. Make the VM template reusable on other machines. Do not bake in the original
   Mac's resource limits, username, filesystem paths, or repositories.
7. Keep this bootstrap generic. In particular, do not create Bazel configuration
   or caches as part of VM setup. All eventual Bazel state belongs inside Linux.
8. Later, adapt agentbox into a Linux process jail inside this workstation.
   Creating the workstation and implementing that jail are separate tasks.

There is no current requirement to implement a cross-platform agentbox backend.
The generic guest template should avoid unnecessary host coupling, but support
for other hypervisors/host OSes should not become a separate project now.

## Intended architecture

```text
Mac or other supported Lima host
  terminal / SSH client
  Lima instance lifecycle and disk image
    |
    +-- persistent Linux workstation VM
          ordinary Linux user and installed development tools
          source checkouts and git worktrees on a Linux filesystem
          build caches and container storage on that same Linux filesystem
          future agentbox jails around agents and their delegated work
```

The virtual disk file necessarily lives on the physical host. That is different
from mounting a Mac directory into Linux: the guest sees a block device with a
Linux filesystem, not the Mac's home directory or repository paths.

The guest is the user's workstation, with normal guest administrative access.
It is **not itself an agent jail**. Do not describe an unrestricted shell in
this VM as a configured, safe YOLO-agent environment.

## Separate the template from host configuration

### Shared guest template: `vm/ubuntu.yaml`

Keep these concerns in the reusable file:

- Ubuntu LTS cloud images for native ARM64 and x86-64 guests.
- Verified image checksums and a minimum compatible Lima version.
- A normal guest home derived from Lima's user template variable.
- No host mounts, SSH-agent/X11 forwarding, proxy-environment inheritance, or
  implicitly imported host SSH public keys.
- No automatic publication of arbitrary guest ports onto host localhost.
- A small generic set of terminal/build tools.
- Idempotent first-boot package setup; no large upgrade on every subsequent boot.
- Guest clock synchronization and DNS support for laptop/network changes.

Keep these out of the shared template:

- Fixed CPU count, memory allocation, or disk capacity.
- Machine-specific VM driver, networking backend, or disk-image format.
- An explicit host username, absolute host path, or physical NIC name.
- Repositories, worktrees, language/project configurations, build-cache paths,
  credentials, agent settings, Docker daemon, or shell dotfile copies.

The current draft installs generic build/terminal packages, plus `bubblewrap`,
`socat`, and `uidmap` as available Linux sandbox primitives, and `fio`/`sysbench`
for bounded validation. It does not launch agents or a container daemon.
Review the package set when resuming; trim optional tools if appropriate rather
than adding project-specific dependencies.

### Per-machine choices: creation arguments

Apply resource sizing and backend choices through `limactl create` flags. Lima
stores the resolved configuration with that instance. There is no need for a
custom VM orchestration framework or a profile format of our own at this stage.

The original Mac was inspected and had:

| Property             | Observed value / proposed choice                    |
| -------------------- | --------------------------------------------------- |
| CPU                  | Apple M1 Pro, 8 cores: 6 performance + 2 efficiency |
| RAM                  | 16 GiB physical                                     |
| OS                   | macOS 26.6.2                                        |
| Lima                 | 2.2.0                                               |
| Free storage         | About 302 GiB at inspection time                    |
| Proposed guest CPU   | All 8 vCPUs                                         |
| Proposed guest RAM   | 12 GiB, leaving 4 GiB for macOS and host processes  |
| Proposed guest disk  | 200 GiB sparse capacity                             |
| Proposed backend     | VZ, native ARM64, no whole-machine x86 emulation    |
| Proposed network     | vzNAT                                               |
| Proposed disk format | ASIF, supported by this macOS/Lima combination      |

These are an example, **not defaults to carry blindly onto the next machine**.
Giving a guest 8 vCPUs does not exclusively pin or reserve 8 physical cores.
Giving a 16 GiB Mac all 16 GiB of guest RAM would starve the host and can reduce
performance through memory pressure. Start with most RAM, retain host headroom,
and tune after measuring a representative workload.

ASIF was selected as a supported native sparse format, not as a proven winner
in a benchmark on this Mac. It requires macOS 26+. Lima's installed comments
warn that converting ASIF back to raw is not supported; use raw instead if
compatibility or recovery requirements make that preferable. Do not enable
unsafe write caching or weaken filesystem durability to inflate benchmarks.

## Phase 1: inspect the destination host and review the draft

Read applicable `AGENTS.md` instructions and preserve existing changes first.
Then use read-only checks such as:

```sh
git status --short
limactl --version
limactl list --json
limactl create --help
limactl autostart enable --help
uname -m
sw_vers
sysctl hw.memsize hw.ncpu hw.model machdep.cpu.brand_string
df -h .
```

The last three host-specific checks are for macOS; use the destination's
equivalents if appropriate. Read only the required configuration/specifications,
not private SSH keys or credential files. In a restricted coding-agent session,
request execution approval when required rather than circumventing the sandbox.

Review Lima-wide `default.yaml`/`override.yaml` if present: effective instance
settings matter more than the visible contents of our template. A machine-wide
override must not silently reintroduce mounts or credential forwarding.

Review image availability and the installed Lima schema:

- The draft pins Ubuntu **26.04 LTS** images dated **2026-07-20**.
- Both URLs and hashes came from the installed Lima 2.2.0 Ubuntu template.
- Dated Canonical images can expire. If unavailable, refresh the URLs and
  verified hashes together from official sources. Do not drop digest checking
  just to get a download to succeed.
- `internal_netplanOptional` is the Ubuntu 26.04 NIC-rename workaround included
  in that Lima version's template. Confirm it is still appropriate.
- Confirm ASIF, VZ networking, and SSH-over-vsock support against the actual
  installed release. Current website documentation may describe newer behavior.

Run `limactl validate vm/ubuntu.yaml`. Inspect any merged/resolved configuration
available from the installed CLI before booting. Specifically verify that no
default template imports have caused the host home to be mounted.

## Phase 2: create a new workstation instance

Choose an unused instance name, normally `dev`. If it already exists, inspect
it and ask how to proceed if ownership/purpose is unclear. Do not overwrite,
factory-reset, prune, or delete an existing VM.

For a machine matching the original Mac, the proposed command is:

```sh
limactl create --name=dev \
  --vm-type=vz --network=vzNAT \
  --cpus=8 --memory=12 --disk=200 \
  --set '.vmOpts.vz.diskImageFormat = "asif"' \
  vm/ubuntu.yaml
```

Adapt the resource arguments to the destination. Omit ASIF on unsupported Macs.
Use a native guest architecture. Do not turn on nested hardware virtualization:
ordinary Linux containers do not require it, and the original M1 does not
support the nested-VM capability needed by some other products.

On macOS, prefer VZ. vzNAT provides a native networking path and guest IP access
without installing a separate privileged socket_vmnet helper. Check VPN/DNS
behavior in practice; throughput does not guarantee compatibility with every VPN.

After creation, inspect the saved instance configuration. Then:

```sh
limactl start dev
limactl shell dev
```

Treat image downloads and first boot as potentially long-running operations.
Keep the user informed, capture errors, and inspect the cloud-init and Lima
logs if startup fails. Do not repeatedly create replacement instances without
understanding and reporting the failure.

## Phase 3: provision only the generic workstation

The draft provisioning script aims to:

1. Update Ubuntu package metadata and upgrade packages on initial setup.
2. Install basic compilers, Git, SSH client, Python, terminal utilities, and
   diagnostic tools from Ubuntu's repositories.
3. Write its completion marker only after those steps succeed.
4. Enable periodic filesystem trim if supported.
5. Create an empty `~/src` inside Linux.

Confirm that provisioning is noninteractive and handles package locks/retries
without masking failures. Verify that rerunning it on restart is harmless and
does not repeat expensive setup. An initial package upgrade may install a new
kernel; check for a required reboot and perform a controlled guest restart
before final validation when necessary.

Do not install every language runtime, import shell dotfiles, clone the user's
repositories, transfer credentials, or configure Bazel as part of this phase.
Those are follow-on development-environment choices inside the guest.

## Phase 4: verify correctness and containment

Record actual observations, not just the desired settings from YAML.

### Guest and storage

- Verify Ubuntu version, native architecture, kernel, visible vCPUs, and RAM.
- Check root and home are on the guest's Linux filesystem with expected capacity.
- Verify sparse host disk consumption is much less than its logical 200 GiB
  capacity initially. Leave physical disk headroom for growth and host operation.
- Confirm cloud-init/provisioning succeeded and inspect failed systemd units.
- Check package tools, ordinary compilation, Python, Git, and tmux work.
- Verify time synchronization and trim support. Do not disable security/kernel
  controls globally just to make a sandbox tool smoke test pass.

Useful read-only guest checks include:

```sh
limactl shell dev cat /etc/os-release
limactl shell dev uname -a
limactl shell dev nproc
limactl shell dev free -h
limactl shell dev findmnt
limactl shell dev df -h
limactl shell dev cloud-init status --long
limactl shell dev systemctl --failed
limactl shell dev timedatectl
```

### Host integrations

- Verify no host filesystem shares appear in guest mounts, including unexpected
  virtiofs/9p/SSHFS shares. A read-only Mac home mount is still unwanted access.
- Verify the guest has no forwarded host SSH-agent socket.
- Verify no host Docker socket or copied host credentials were introduced.
- Start a temporary test service and verify automatic host-localhost publication
  is disabled. Explicit SSH port forwarding should still work.
- Confirm the final SSH client configuration disables agent forwarding too;
  do not rely solely on an empty environment variable in one test shell.

### Network boundary: be precise

The planned baseline disables file/credential sharing, **not all host network
access**. vzNAT is not a firewall against Mac/LAN services, and the guest retains
internet access. Lima's guest agent and host-backed DNS remain deliberate
integrations for clock/network behavior.

Do not call this fully isolated in the sense of no possible host interaction.
If the user intends no guest access to Mac/LAN services either, settle and
implement that additional network policy explicitly. Do not claim that NAT or
an agent-editable guest firewall alone provides that stronger boundary.

## Phase 5: bounded performance checks

The key performance decisions are native CPU architecture, guest-local block
storage, sufficient RAM without host swapping, and avoiding unnecessary daemon
or GUI workloads. Avoid speculative sysctl tuning.

Perform short, clearly scoped tests:

- CPU: a brief single-thread and all-vCPU `sysbench cpu` run, or equivalent.
- Storage: fio against a **new temporary file on the guest disk**, testing
  sequential and small-file/random I/O as appropriate. Never target a block
  device, repository, existing file, or host filesystem. Keep sizes/runtime small.
- Networking: DNS and HTTPS downloads to a public endpoint; optionally measure
  local host-to-guest throughput using a deliberately started temporary service.
- Memory: observe guest memory and host memory pressure/swap during load. Adjust
  allocation downward if host swapping negates the intended performance gain.
- Responsiveness: confirm terminal interaction and basic builds remain usable.

Report benchmark method, duration, and results. Direct I/O in Linux can still
interact with host-side virtualization/storage caches; do not label a quick
synthetic result as guaranteed sustained SSD or real-project build performance.
Clean up only the specific temporary benchmark files/services created for tests.

A representative repository build is the eventual best performance check, but
do not transfer a private checkout just to run one without the user's direction.

## Phase 6: persistent daily operation

- Verify a controlled stop/start preserves a temporary guest test file and does
  not repeat first-boot provisioning. Restart before the user begins real work.
- Enable login-time autostart using the installed Lima command if the user is
  ready for this machine to allocate resources automatically at login.
- Prefer a user LaunchAgent on a MacBook. A root boot-time LaunchDaemon is not
  needed merely because the guest has no GUI.
- Inspect the generated autostart registration and supported restart behavior;
  do not assume flags from newer docs exist in this Lima release.
- Use guest tmux for terminal-disconnect persistence. Explain that tmux does
  not preserve processes across a guest or Mac reboot.
- Have the user exercise laptop sleep/wake and VPN/network changes. Do not put
  their Mac to sleep, reboot it, or change their active VPN as an automated test.
- Retain clock synchronization; do not blindly select `plain: true`, which
  disables that feature along with unwanted integrations.

Provide exact connection and lifecycle commands. Standard SSH can use Lima's
generated config directly; editing the Mac's global SSH config is unnecessary:

```sh
limactl shell dev
ssh -F "$HOME/.lima/dev/ssh.config" lima-dev
limactl stop dev
limactl start dev
```

If `LIMA_HOME` is customized, discover the actual SSH config using Lima rather
than assuming that path. For development web ports, document explicit tunnels.

## Phase 7: documentation and acceptance criteria

Update `vm/README.md` with what was actually tested, the final host profile,
known limitations, guest-maintenance instructions, and connection commands.
Keep machine-specific paths and results out of the reusable YAML.

Completion criteria for the workstation setup:

- [ ] Shared template validates with the installed Lima release.
- [ ] A newly named VM boots the selected native Ubuntu LTS image successfully.
- [ ] Effective CPU, memory, disk, and networking match the chosen host profile.
- [ ] Generic provisioning and an ordinary compile/test smoke check pass.
- [ ] Guest data stays on its Linux disk; no host filesystem/credential sharing.
- [ ] SSH works and unexpected guest-port publication is disabled.
- [ ] Short performance checks and host memory-pressure observations are recorded.
- [ ] Stop/start preserves data; autostart is configured or explicitly deferred.
- [ ] Sleep/wake and VPN testing is done by the user or clearly marked untested.
- [ ] The user receives commands, limitations, and an honest backup status.

Backups remain essential once this becomes the user's primary workstation.
Git pushes alone omit uncommitted changes, ignored files, and local state.
Choose a backup destination and policy with the user before configuring
scheduled transfers. Do not upload source or credentials as an implicit setup
step. Prefer consistent stopped-VM backups or appropriately designed guest
backups; do not promise that copying a live disk gives an application-consistent
backup. Do not rely on experimental snapshot features as the only protection.

## Later work: agentbox inside Linux (not part of VM bootstrap)

Once the workstation works, separately implement and verify Linux agent jails.
Keep this discussion here so a resumed session does not accidentally reintroduce
the previous Mac/Linux file-sharing architecture.

Likely direction:

- Keep agentbox's configuration/credential selection interface, with credentials
  introduced deliberately inside Linux or through a separately designed broker.
- Use SRT's Linux/bubblewrap backend to restrict the entire agent process tree.
- Expose only the intended checkout, necessary read-only toolchains, and selected
  writable guest directories. Keep policy/configuration outside agent control.
- Preserve PID/proc isolation, scoped network/IPC access, and resource limits.
  Review existing weaker-nested-sandbox settings before reusing current policy.
- Keep Git worktrees within a common trust group; shared writable Git metadata
  is not a security boundary. Use separate clones when permissions truly differ.
- Configure shared build caches **inside Linux**, separate from Bazel servers
  and output directories. Avoid delegating agent builds to an unsandboxed server.
- Do not give agents the workstation's rootful Docker socket. Rootless Docker
  outside the jail under the normal developer account is also not enough: that
  daemon retains the account's access. Prototype a genuinely constrained runtime
  for each trust profile and validate it with the jail's namespace restrictions.
- Linux jails share a kernel with the workstation; a kernel escape can compromise
  the VM. The outer VM boundary does not make agent-modified code safe to execute
  later with stronger privileges or credentials.

Existing files to inspect during that separate task include
`src/policy.ts`, `src/bazel.ts`, `src/lima-backend.ts`, `src/credentials.ts`, and
`src/seatbelt.ts`. Do not repurpose the existing Mac-oriented Docker VM backend
as this workstation launcher without an explicit design and implementation task.

## Reference material already consulted

Check the installed CLI/schema first, and verify these sources again when
resuming if versions have changed:

- [Lima VZ backend](https://lima-vm.io/docs/config/vmtype/vz/)
- [Lima VMNet / vzNAT](https://lima-vm.io/docs/config/network/vmnet/)
- [Lima port forwarding and SSH-over-vsock](https://lima-vm.io/docs/config/port/)
- [Lima plain-mode tradeoffs](https://lima-vm.io/docs/config/plain/)
- [Lima automatic startup](https://lima-vm.io/docs/usage/autostart/)
- [Lima experimental features](https://lima-vm.io/docs/releases/experimental/)
- [Ubuntu LTS support](https://ubuntu.com/about/release-cycle)
- [Apple virtual disk formats](https://developer.apple.com/documentation/virtualization/vzdiskimagestoragedeviceattachment)

## Suggested resume request

> Read `vm/PLAN.md`, `vm/README.md`, and `vm/ubuntu.yaml`. Inspect this machine
> and resume implementing the generic Linux workstation VM plan. Use most of
> this machine's resources while leaving enough for the host. Keep all source,
> build, and container data inside Linux, with no host file or credential
> sharing. Validate the template and the running VM before declaring success.
> Do not migrate repositories/credentials or implement agentbox policy yet.
