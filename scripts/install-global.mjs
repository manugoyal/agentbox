import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  console.log("Usage: npm run install:global -- [--node VERSION]");
  process.exit(0);
}

let nodeVersion;
if (argv.length) {
  if (
    argv.length !== 2 ||
    argv[0] !== "--node" ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(argv[1])
  ) {
    console.error("Usage: npm run install:global -- [--node VERSION]");
    process.exit(2);
  }
  nodeVersion = argv[1];
}

const root = fileURLToPath(new URL("..", import.meta.url));
const npmArgs = ["install", "--global", "--install-links", "."];
const command = nodeVersion ? "mise" : "npm";
const args = nodeVersion
  ? ["exec", `node@${nodeVersion}`, "--", "npm", ...npmArgs]
  : npmArgs;
const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });

if (result.error) {
  if (nodeVersion && result.error.code === "ENOENT")
    console.error("agentbox: mise is required when --node is specified");
  else
    console.error(`agentbox: global install failed: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
