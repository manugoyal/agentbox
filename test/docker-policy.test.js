import assert from "node:assert/strict";
import test from "node:test";

import {
  DockerPolicyError,
  canonicalImageReference,
  imageReferenceFromPullUrl,
  sanitizeContainerCreate,
  sanitizeExecCreate,
  sanitizeExecStart,
} from "../dist/docker-policy.js";

test("image policy accepts Bollard's empty import parameters", () => {
  assert.equal(
    imageReferenceFromPullUrl(
      new URL(
        "http://docker.invalid/images/create?fromImage=postgres%3A15-alpine&fromSrc=&repo=&tag=&platform=&changes=",
      ),
    ),
    "docker.io/library/postgres:15-alpine",
  );
  assert.throws(
    () =>
      imageReferenceFromPullUrl(
        new URL(
          "http://docker.invalid/images/create?fromImage=postgres&fromSrc=https%3A%2F%2Fexample.com%2Fimage.tar",
        ),
      ),
    DockerPolicyError,
  );
});

test("image policy canonicalizes Docker Hub short forms", () => {
  assert.equal(
    canonicalImageReference("alpine:3.21"),
    "docker.io/library/alpine:3.21",
  );
  assert.equal(
    canonicalImageReference("docker.io/library/alpine:3.21"),
    "docker.io/library/alpine:3.21",
  );
  assert.equal(
    canonicalImageReference("ghcr.io/example/tool"),
    "ghcr.io/example/tool:latest",
  );
});

test("container policy allows arbitrary images but rebuilds host configuration", () => {
  const result = sanitizeContainerCreate(
    {
      Image: "example.invalid/a-completely-custom-image:latest",
      Env: ["EXAMPLE=value"],
      Cmd: ["serve"],
      ExposedPorts: { "8080/tcp": {} },
      HostConfig: {
        Privileged: false,
        ExtraHosts: [],
        PublishAllPorts: true,
        PortBindings: {
          "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }],
        },
      },
    },
    "session-id",
    "session-network",
  );

  assert.equal(
    result.Image,
    "example.invalid/a-completely-custom-image:latest",
  );
  assert.equal(result.HostConfig.NetworkMode, "session-network");
  assert.equal(result.HostConfig.Privileged, false);
  assert.deepEqual(result.HostConfig.SecurityOpt, ["no-new-privileges"]);
  assert.deepEqual(result.HostConfig.PortBindings, {
    "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }],
  });
  assert.equal(result.Labels["dev.agentbox.session"], "session-id");
});

test("container policy rejects published non-TCP ports", () => {
  assert.throws(
    () =>
      sanitizeContainerCreate(
        {
          Image: "example.invalid/service:latest",
          ExposedPorts: { "8125/udp": {} },
          HostConfig: {
            PortBindings: {
              "8125/udp": [{ HostPort: "8125" }],
            },
          },
        },
        "session",
        "network",
      ),
    /supports publishing TCP ports only/,
  );
});

test("container policy discards Docker CLI zero values before validation", () => {
  const result = sanitizeContainerCreate(
    {
      Image: "alpine:3.21",
      Env: null,
      Entrypoint: null,
      Volumes: null,
      NetworkingConfig: {
        EndpointsConfig: {
          default: {
            IPAMConfig: null,
            Aliases: null,
            DriverOpts: null,
          },
        },
      },
      HostConfig: {
        Binds: null,
        CapAdd: null,
        Devices: null,
        ExtraHosts: null,
        NetworkMode: "default",
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
        MemorySwappiness: -1,
        Privileged: false,
      },
    },
    "session",
    "network",
  );

  assert.equal(result.Image, "alpine:3.21");
  assert.equal(result.HostConfig.NetworkMode, "network");
  assert.equal(result.HostConfig.Privileged, false);
});

for (const [name, body] of [
  [
    "bind mounts",
    { Image: "postgres:15-alpine", HostConfig: { Binds: ["/:/host"] } },
  ],
  [
    "structured mounts",
    {
      Image: "postgres:15-alpine",
      HostConfig: {
        Mounts: [{ Type: "bind", Source: "/", Target: "/host" }],
      },
    },
  ],
  [
    "existing volumes",
    {
      Image: "postgres:15-alpine",
      HostConfig: { VolumesFrom: ["sensitive-container"] },
    },
  ],
  [
    "privileged mode",
    { Image: "postgres:15-alpine", HostConfig: { Privileged: true } },
  ],
  [
    "host networking",
    { Image: "postgres:15-alpine", HostConfig: { NetworkMode: "host" } },
  ],
  [
    "host process namespace",
    { Image: "postgres:15-alpine", HostConfig: { PidMode: "host" } },
  ],
  [
    "devices",
    {
      Image: "postgres:15-alpine",
      HostConfig: { Devices: [{ PathOnHost: "/dev/disk0" }] },
    },
  ],
  [
    "capability additions",
    { Image: "postgres:15-alpine", HostConfig: { CapAdd: ["SYS_ADMIN"] } },
  ],
  [
    "security profile overrides",
    {
      Image: "postgres:15-alpine",
      HostConfig: { SecurityOpt: ["seccomp=unconfined"] },
    },
  ],
  [
    "top-level volume declarations",
    { Image: "postgres:15-alpine", Volumes: { "/data": {} } },
  ],
  [
    "client-selected container networking",
    {
      Image: "postgres:15-alpine",
      NetworkingConfig: {
        EndpointsConfig: { host: { Aliases: ["escape"] } },
      },
    },
  ],
]) {
  test(`container policy rejects ${name}`, () => {
    assert.throws(
      () => sanitizeContainerCreate(body, "session", "network"),
      DockerPolicyError,
    );
  });
}

test("exec policy rejects privileged execs", () => {
  assert.throws(
    () => sanitizeExecCreate({ Cmd: ["sh"], Privileged: true }),
    DockerPolicyError,
  );
});

test("exec policy accepts Bollard's null options without forwarding them", () => {
  assert.deepEqual(
    sanitizeExecCreate({
      AttachStdin: null,
      AttachStdout: true,
      AttachStderr: true,
      DetachKeys: null,
      Tty: null,
      Env: null,
      Cmd: ["mc", "ready", "local"],
      Privileged: null,
      User: null,
      WorkingDir: null,
    }),
    {
      AttachStdout: true,
      AttachStderr: true,
      Cmd: ["mc", "ready", "local"],
      Privileged: false,
    },
  );
  assert.deepEqual(
    sanitizeExecStart({ Detach: false, Tty: false, OutputCapacity: null }),
    { Detach: false, Tty: false },
  );
});
