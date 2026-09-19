/** A real bare Git origin in the VM. Only the host initiates SSH connections. */
import { spawnSync } from "node:child_process";
import { nameSchema } from "./config.js";
import { type Connection, shellQuote } from "./lima.js";
import { fail, findExecutable, runChild } from "./system.js";

const repositoryScript = `set -eu
path="$HOME/.local/share/agentbox/exchange/$1.git"
if [ "$2" = init ]; then
  mkdir -p "\${path%/*}"
  if [ ! -e "$path" ]; then
    git -c core.hooksPath=/dev/null init --bare --initial-branch=main "$path" >/dev/null
  fi
  git -C "$path" config core.hooksPath /dev/null
fi
test "$(git -C "$path" rev-parse --is-bare-repository)" = true
printf %s "$path"
`;

export async function exchange(
  connection: Connection,
  operation: string,
  name: string,
  refspec?: string,
): Promise<number> {
  nameSchema.parse(name);
  if (!["init", "push", "fetch"].includes(operation))
    fail("git operation must be init, push or fetch");
  const path = connection.capture([
    "/bin/sh",
    "-c",
    repositoryScript,
    "agentbox",
    name,
    operation,
  ]);
  if (!path.startsWith("/") || /[\x00-\x1f]/.test(path))
    fail("VM returned an invalid Git repository path");
  if (operation === "init") {
    console.log(
      `Guest Git origin: ${path}\nIn a guest checkout: git remote add exchange ${shellQuote(path)}\nThen: git push exchange HEAD:refs/heads/my-work\nOn the host: agentbox git fetch ${name}`,
    );
    return 0;
  }
  const git = findExecutable("git") ?? fail("Git is required on the host");
  const url = `ssh://${connection.destination}${path.split("/").map(encodeURIComponent).join("/")}`;
  const args = [
    "-c",
    `core.sshCommand=${connection.gitCommand()}`,
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.ssh.allow=always",
  ];
  if (operation === "push") args.push("push", "--", url, refspec ?? "HEAD");
  else
    args.push(
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--",
      url,
      `+refs/heads/*:refs/remotes/agentbox/${name}/*`,
    );
  return runChild(git, args, { env: connection.env, stdio: "inherit" });
}

/** Fetch one exchange, then publish its branch using the host checkout's origin. */
export async function publish(
  connection: Connection,
  name: string,
  branch: string,
): Promise<number> {
  const git = findExecutable("git") ?? fail("Git is required on the host");
  const checked = spawnSync(git, ["check-ref-format", "--branch", branch], {
    env: process.env,
    stdio: "ignore",
  });
  if (checked.error || checked.status !== 0) fail("invalid Git branch name");
  const fetched = await exchange(connection, "fetch", name);
  if (fetched !== 0) return fetched;
  return runChild(
    git,
    [
      "push",
      "--",
      "origin",
      `refs/remotes/agentbox/${name}/${branch}:refs/heads/${branch}`,
    ],
    { env: process.env, stdio: "inherit" },
  );
}
