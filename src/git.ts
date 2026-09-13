/** A real bare Git origin in the VM. Only the host initiates SSH connections. */
import { runChild } from "./child-process.js";
import { nameSchema } from "./config.js";
import { fail } from "./errors.js";
import { type Connection, shellQuote } from "./lima.js";
import { findExecutable } from "./system.js";

const repositoryScript = `
import json, os, subprocess, sys
name, operation = sys.argv[1:]
path = os.path.expanduser("~/.local/share/agentbox/exchange/" + name + ".git")
if operation == "init":
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "init", "--bare", "--initial-branch=main", path], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(["git", "-C", path, "config", "core.hooksPath", "/dev/null"], check=True)
if subprocess.check_output(["git", "-C", path, "rev-parse", "--is-bare-repository"], text=True).strip() != "true":
    raise ValueError("exchange must be a bare repository")
print(json.dumps(path))
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
  const path: unknown = JSON.parse(
    connection.capture([
      "/usr/bin/python3",
      "-c",
      repositoryScript,
      name,
      operation,
    ]),
  );
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    /[\x00-\x1f]/.test(path)
  )
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
  const env = { ...connection.env };
  delete env.GIT_SSH;
  delete env.GIT_SSH_COMMAND;
  return runChild(git, args, { env, stdio: "inherit" });
}
