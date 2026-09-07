# Linux validation

Tested September 10–11, 2026 inside the user's existing Lima workstation:

- Ubuntu 26.04.1 LTS, ARM64, Linux 7.0.0-31-generic.
- Node 24.18.1; Bubblewrap 0.11.1.
- Docker 29.1.3, containerd 2.2.2, runc 1.4.0, slirp4netns 1.3.3.
- AppArmor enabled; `kernel.apparmor_restrict_unprivileged_userns` remains `1`.
- Core process jails need no AppArmor configuration change.
- Docker mode uses `linux/agentbox-bwrap` and its explicit AppArmor profile.
- Workstation Docker/containerd services and Docker socket are masked and inactive.

All 18 core tests and all 4 optional Docker tests pass. TypeScript, formatting,
diff whitespace checks and the npm package dry run also pass.

The core integration suite exercises argv/stdin/exit codes, private home and
scratch storage, environment filtering, symlinks, read-only grants and policy
replacement, private proc and namespaces, local TCP/Unix sockets, Git worktrees,
normal exit and SIGTERM/SIGKILL cleanup, and enforced cgroup limits.

The Docker suite imports a local BusyBox root filesystem, runs containers with
multiple UIDs, writes a bind-mounted workspace, checks read-only protections
with all container capabilities, uses a bridge network and published port
inside the jail, reuses explicitly granted Docker data across launches, and
checks process cleanup, preservation of enclosing cgroup limits, and that user
runtime hooks execute only after the restrictive namespace is entered. A separate
online smoke check pulled and ran `alpine:3.23` through `agentbox --docker`.

A Bazel 9.1.0 Starlark shell-action target was built in two separate launches.
Only its repository and disk cache directories were shared; each launch used
`--output_user_root=/tmp/bazel` in a fresh private `/tmp`. The first build used
`processwrapper-sandbox`; the second reported **1 disk cache hit**. No Bazel
shim, shared server, generated rc file, or command rewriting was used. These
are a functional cache check, not a representative build benchmark.

An interactive Bash check confirmed that terminal stdin is passed through.
Bash reports no job control because the jail creates a new session. Full TUI
resize behavior and a representative project/testcontainers workload have not
been verified. Container requests for writable sysfs (including some
`--privileged` uses) can fail; that does not remove the outer jail boundary.

This validates the process sandbox on this VM. It does not validate or alter
the earlier Lima workstation bootstrap acceptance criteria in `vm/PLAN.md`.
