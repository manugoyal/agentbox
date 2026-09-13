# Continue agentbox development on the host

The CLI now runs on the host and manages a persistent Lima VM. The code was
developed inside the existing `lima-dev` guest. Continue development and
end-to-end validation from a checkout on the physical host.

Read the [main README](../README.md) for the current architecture and
[validation plan](PLAN.md) for the remaining host checks.

## Set up the host checkout

From the repository root on the host, with Node.js 20.11 or newer, Lima 2.2 or
newer, Git, and OpenSSH installed:

```sh
npm ci
npm run install:global
mkdir -p ~/.config/agentbox
# Generate an example without overwriting any existing configuration.
agentbox --print-config > ~/.config/agentbox/config.example.toml
```

Review the example and save the desired settings in
`~/.config/agentbox/config.toml`. Keep 1Password and AWS authentication on the
host. Only configure credentials that already have the intended provider-side
permissions and lifetime.

```sh
agentbox vm config
agentbox vm start
agentbox -- bash -l
```

The default instance uses `~/.local/share/agentbox/lima`, separate from the
existing development VM in Lima's default directory. Shells start in the guest
home directory; use `cd` normally. Follow the validation plan before treating
the new VM as ready for project development.

## Validation

Eight tests pass, including real local OpenSSH credential handoff, binary
stdin, exact arguments, exit status, interactive job control, terminal resizing,
and a real Git round trip. TypeScript, formatting, and whitespace checks pass.
Generated YAML passed the real Lima 2.2 validator. VM creation, provisioning,
host networking, and a full Braintrust build still need host-level testing.

Use a fresh instance and the CLI's dedicated Lima home. The existing guest was
used for earlier process-sandbox experiments and is not a validation of the new
template: its previous global agentbox installation and sandbox-related system
setup have not been migrated. The repository implementation removes Bubblewrap;
the existing guest may still have the earlier system entrypoint and AppArmor
profile installed and system Docker services masked. It also contains existing
user authentication stores that have not been audited for permissions.
