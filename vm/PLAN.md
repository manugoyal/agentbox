# VM-only implementation and host validation

## Accepted design

Agentbox manages a persistent Lima VM and launches commands in it. The VM is the
entire execution boundary: guest programs may use sudo, Docker, normal build
tools, and persistent caches. No process jail runs inside it.

Host directories, authentication agents, and Docker sockets are not shared with
the guest. The host keeps 1Password authentication and AWS login state, resolving
only selected values for a guest process environment. External permissions and
expiry are configured at the providers. AWS exports must be temporary; stored
1Password tokens retain the scopes and lifetime they were issued with.

Code moves through a bare Git exchange inside the VM. Only the host initiates
SSH connections. Both sides can push branches, and host fetches leave the
working tree unchanged for explicit review. Shells start in the guest home
and use ordinary `cd`; there is no working-directory setting.

## Implemented and checked inside the existing guest

- Host CLI: generate config, create/start/stop/status, credential sessions, and
  Git init/push/fetch.
- Host resource detection, percentage controls, explicit localhost TCP ports,
  dedicated Lima home, and validation of host-sharing restrictions.
- Ubuntu template with no host mounts or forwarded agents and an ordinary guest
  Docker daemon, Compose, and Buildx.
- Host-only AWS and 1Password lookup; no ambient host credential forwarding.
- Real local SSH tests: selected synthetic credentials, binary stdin, argument
  fidelity, exit status, interactive job control, and actual terminal resizing.
- Real Git round trip: host push, guest commit and push, host fetch, preserved
  host working tree, and disabled host hooks for exchange commands.
- Mocked Lima lifecycle test and real Lima 2.2 YAML validation.

These checks ran inside an Ubuntu ARM64 Lima guest. They do not establish that
new-instance provisioning or host port forwarding works. No new VM has been
created from this implementation on the physical host.

## Continue on the host

Start with the [host handoff](HANDOFF.md) for installation and session setup.

Preserve the current uncommitted work and the user's index. Do not commit or
restage without direction. Install the current source on the host, read the main
README, and use a fresh, dedicated Lima directory so existing unrelated instances
are unaffected.

1. Inspect host CPU, memory, Lima version, and driver availability. Review
   `agentbox vm config`; confirm empty mounts and copy rules, disabled agents,
   and only the requested localhost ports.
2. Run `agentbox vm start`. Verify image download, first-boot provisioning,
   normal guest sudo, and Docker group access in a new session. Confirm a second
   start retains state without rerunning package setup.
3. Open `agentbox -- bash -l`. Check terminal resizing, Ctrl-C, job control,
   binary pipes, exit status, and that host-only files and authentication stores
   are absent from the guest.
4. Start a simple guest HTTP service on a configured port. Verify host loopback
   access and lack of automatic publication of an unconfigured port. Confirm
   guest Docker runs containers and Compose works with guest bind mounts.
5. Configure intentionally limited test credentials on the host. Verify expected
   reads and rejected writes at each provider using disposable test resources.
   Check AWS expiration and refresh via a new host-launched session. Never
   assume that a profile or token name proves read-only permissions.
6. Exchange a real project through Git. Build and run it using its normal setup
   commands inside the VM. Verify caches, Docker images, and volumes persist
   across shell sessions and VM restarts. Fetch a guest branch on the host and
   review it without changing the host worktree.
7. Check sleep/wake networking and clock behavior on the laptop, restart the VM,
   and document backup and recovery of work not yet fetched to the host.

The earlier Braintrust service attempt used the retired process sandbox and did
not establish that all services build or run. Repeat project validation in the
new VM after the host-level checks succeed.
