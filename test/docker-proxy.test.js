import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { RestrictedDockerProxy } from "../dist/docker-proxy.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

test("restricted proxy exposes only sanitized session containers", async () => {
  const containerId = "a".repeat(64);
  const helperId = "c".repeat(64);
  const received = [];
  const backend = createServer(async (request, response) => {
    const path = new URL(request.url, "http://docker.invalid").pathname;
    if (request.method === "POST" && path.endsWith("/networks/create")) {
      received.push({ path, body: await readJson(request) });
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ Id: "network-id" }));
      return;
    }
    if (request.method === "POST" && path.endsWith("/images/create")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"downloaded"}\n');
      return;
    }
    if (request.method === "GET" && path.includes("/images/")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    if (request.method === "POST" && path.endsWith("/containers/create")) {
      const body = await readJson(request);
      received.push({ path, body });
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          Id: body.Image.includes("alpine@") ? helperId : containerId,
          Warnings: [],
        }),
      );
      return;
    }
    if (
      request.method === "POST" &&
      path.endsWith(`/containers/${helperId}/start`)
    ) {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "GET" && path.endsWith(`/${containerId}/json`)) {
      received.push({ path, query: new URL(request.url, "http://x").search });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ Id: containerId }));
      return;
    }
    if (request.method === "GET" && path.endsWith("/containers/json")) {
      received.push({ path, query: new URL(request.url, "http://x").search });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ Id: containerId, Ports: [] }]));
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"message":"not found"}');
  });

  let proxy;
  try {
    const backendPort = await listen(backend);
    proxy = new RestrictedDockerProxy({ backendPort });
    await proxy.start();
    const origin = proxy.environment.DOCKER_HOST.replace("tcp://", "http://");

    const unavailable = await fetch(`${origin}/v1.47/containers/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ Image: "postgres:15-alpine" }),
    });
    assert.equal(unavailable.status, 404);

    const pull = await fetch(
      `${origin}/v1.47/images/create?fromImage=postgres%3A15-alpine`,
      { method: "POST" },
    );
    assert.equal(pull.status, 200);
    await pull.text();

    const create = await fetch(
      `${origin}/v1.47/containers/create?name=database`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          Image: "postgres:15-alpine",
          ExposedPorts: { "5432/tcp": {} },
          HostConfig: { Privileged: false, PublishAllPorts: true },
        }),
      },
    );
    assert.equal(create.status, 201, await create.text());

    const containerRequests = received.filter((item) =>
      item.path.endsWith("/containers/create"),
    );
    const containerRequest = containerRequests.find((item) =>
      item.body.Image.startsWith("postgres:"),
    ).body;
    const helperRequest = containerRequests.find((item) =>
      item.body.Image.includes("alpine@"),
    ).body;
    const networkRequest = received.find((item) =>
      item.path.endsWith("/networks/create"),
    ).body;
    assert.equal(networkRequest.Internal, true);
    assert.equal(containerRequest.HostConfig.Privileged, false);
    assert.match(containerRequest.HostConfig.NetworkMode, /^agentbox-/);
    assert.equal(containerRequest.HostConfig.PublishAllPorts, false);
    assert.equal(containerRequest.HostConfig.PortBindings, undefined);
    assert.deepEqual(containerRequest.HostConfig.SecurityOpt, [
      "no-new-privileges",
    ]);
    assert.deepEqual(
      Object.values(containerRequest.NetworkingConfig.EndpointsConfig)[0]
        .Aliases,
      ["database"],
    );
    assert.equal(
      containerRequest.Labels["dev.agentbox.session"],
      proxy.state.sessionId,
    );
    assert.deepEqual(helperRequest.HostConfig.CapDrop, ["ALL"]);
    assert.equal(helperRequest.HostConfig.ReadonlyRootfs, true);
    assert.equal(
      helperRequest.HostConfig.NetworkMode,
      containerRequest.HostConfig.NetworkMode,
    );

    const inspect = await fetch(`${origin}/v1.47/containers/database/json`);
    assert.equal(inspect.status, 200);
    const inspected = await inspect.json();
    assert.equal(
      inspected.NetworkSettings.Ports["5432/tcp"][0].HostIp,
      "127.0.0.1",
    );
    assert.match(
      inspected.NetworkSettings.Ports["5432/tcp"][0].HostPort,
      /^\d+$/,
    );

    const list = await fetch(
      `${origin}/v1.47/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ name: ["database"] }))}`,
    );
    assert.equal(list.status, 200);
    const listed = await list.json();
    assert.deepEqual(listed[0].Ports, [
      {
        IP: "127.0.0.1",
        PrivatePort: 5432,
        PublicPort: Number(
          inspected.NetworkSettings.Ports["5432/tcp"][0].HostPort,
        ),
        Type: "tcp",
      },
    ]);
    const listRequest = received.find((item) =>
      item.path.endsWith("/containers/json"),
    );
    const listFilters = JSON.parse(
      new URLSearchParams(listRequest.query).get("filters"),
    );
    assert.deepEqual(listFilters.label, [
      `dev.agentbox.session=${proxy.state.sessionId}`,
    ]);
    assert.deepEqual(listFilters.id, [containerId]);
    assert.equal(listFilters.name, undefined);

    const foreign = await fetch(
      `${origin}/v1.47/containers/${"b".repeat(64)}/json`,
    );
    assert.equal(foreign.status, 403);

    const mounted = await fetch(`${origin}/v1.47/containers/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        Image: "postgres:15-alpine",
        HostConfig: { Binds: ["/:/host"] },
      }),
    });
    assert.equal(mounted.status, 403);
  } finally {
    await proxy?.close();
    await close(backend);
  }
});
