import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { publishImage, validateImageReference } from "../dist/docker.js";
import { Connection } from "../dist/lima.js";
import { sshFixture } from "./helpers/ssh.js";

const reference = "public.ecr.aws/braintrust/brainstore:manu-test-docker-in-vm";
const imageId =
  "sha256:1f2d3cbd7c0da35418b82811e84dc9b43ef2a3de90bc6136636cbabb44945b88";

test(
  "SSH writes a binary guest stream to an exclusive host file",
  {
    skip: process.platform !== "linux" || !existsSync("/usr/sbin/sshd"),
    timeout: 15000,
  },
  async (t) => {
    const f = await sshFixture(t);
    const destination = join(f.root, "image.tar");
    const connection = new Connection(f.sshConfig, "lima-testvm", f.env);
    const status = await connection.writeOutput(
      [
        "python3",
        "-c",
        "import sys; sys.stdout.buffer.write(bytes([0, 1, 2, 10, 255]))",
      ],
      destination,
    );
    assert.equal(status, 0);
    assert.deepEqual(
      readFileSync(destination),
      Buffer.from([0, 1, 2, 10, 255]),
    );
    await assert.rejects(
      connection.writeOutput(["true"], destination),
      /EEXIST/,
    );
  },
);

test("docker publish exports an exact guest tag and invokes host crane", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-docker-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const log = join(root, "crane.json");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "crane"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({
  args,
  archive: fs.readFileSync(args[1], "utf8"),
  marker: process.env.HOST_AUTH_MARKER,
}));
process.stdout.write("public.ecr.aws/braintrust/brainstore@sha256:digest\\n");
`,
    { mode: 0o755 },
  );
  const commands = [];
  let archivePath;
  const connection = {
    capture(command) {
      commands.push(command);
      return JSON.stringify({
        Id: imageId,
        RepoTags: [reference],
        Os: "linux",
        Architecture: "arm64",
      });
    },
    async writeOutput(command, destination) {
      commands.push(command);
      archivePath = destination;
      writeFileSync(destination, "guest image archive");
      return 0;
    },
  };

  const originalError = console.error;
  const messages = [];
  console.error = (...args) => messages.push(args.join(" "));
  t.after(() => (console.error = originalError));
  const status = await publishImage(connection, reference, {
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    HOST_AUTH_MARKER: "host-only",
  });

  assert.equal(status, 0);
  assert.match(messages.join("\n"), new RegExp(imageId));
  assert.equal(commands[0].at(-1), reference);
  assert.deepEqual(commands[1], ["docker", "image", "save", imageId]);
  const invocation = JSON.parse(readFileSync(log, "utf8"));
  assert.equal(invocation.args[0], "push");
  assert.equal(invocation.args[2], reference);
  assert.equal(invocation.archive, "guest image archive");
  assert.equal(invocation.marker, "host-only");
  assert.equal(existsSync(archivePath), false);
});

test("docker publish rejects ambiguous references and missing guest images", async (t) => {
  for (const invalid of [
    "brainstore",
    "brainstore@sha256:deadbeef",
    "-invalid:tag",
    "brainstore:tag\nsecond",
  ])
    assert.throws(() => validateImageReference(invalid), /explicit tag/);

  const connection = {
    capture() {
      throw new Error("inspect failed");
    },
    async writeOutput() {
      assert.fail("missing image must not be exported");
    },
  };
  const root = mkdtempSync(join(tmpdir(), "agentbox-docker-missing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "crane"), "#!/bin/sh\nexit 99\n", {
    mode: 0o755,
  });
  await assert.rejects(
    publishImage(connection, reference, { PATH: root }),
    /guest image does not exist or Docker cannot inspect it/,
  );
});

test("docker publish removes partial archives after export failure", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-docker-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "crane"), "#!/bin/sh\nexit 99\n", {
    mode: 0o755,
  });
  let archivePath;
  const connection = {
    capture() {
      return JSON.stringify({
        Id: imageId,
        RepoTags: [reference],
        Os: "linux",
        Architecture: "arm64",
      });
    },
    async writeOutput(_command, destination) {
      archivePath = destination;
      writeFileSync(destination, "partial");
      return 23;
    },
  };

  assert.equal(await publishImage(connection, reference, { PATH: bin }), 23);
  assert.equal(existsSync(archivePath), false);
});
