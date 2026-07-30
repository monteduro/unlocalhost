import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rebuildCaddyfile } from "../src/caddy.js";
import { initializeHome } from "../src/config.js";
import { addEndpoint, addProject } from "../src/registry.js";
import { fullStatus } from "../src/status.js";

test("status schema reports a reachable bare upstream and proxy route", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "unlocalhost-status-"));
  const home = path.join(root, "state");
  const projectPath = path.join(root, "app");
  await fs.mkdir(projectPath);
  const server = http.createServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });
  const apiServer = http.createServer((_request, response) => {
    response.writeHead(200);
    response.end("api");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const apiAddress = apiServer.address();
  assert.ok(address && typeof address === "object");
  assert.ok(apiAddress && typeof apiAddress === "object");
  try {
    const initialized = await initializeHome(home);
    await addProject(home, {
      path: projectPath,
      slug: "status-app",
      port: address.port,
    });
    await addEndpoint(home, "status-app", {
      id: "api",
      port: apiAddress.port,
    });
    await rebuildCaddyfile(home, initialized.config);
    const result = await fullStatus(home, initialized.config);
    assert.equal(result.schema_version, 1);
    const projects = result.projects as Array<Record<string, unknown>>;
    assert.equal(projects.length, 1);
    assert.equal(projects[0]?.proxy_route, true);
    assert.deepEqual(projects[0]?.upstream_health, {
      reachable: true,
      status: 204,
      error: null,
    });
    const endpoints = projects[0]?.endpoints as Array<Record<string, unknown>>;
    assert.equal(endpoints.length, 2);
    assert.equal(endpoints[1]?.id, "api");
    assert.deepEqual(endpoints[1]?.upstream_health, {
      reachable: true,
      status: 200,
      error: null,
    });
  } finally {
    await Promise.all(
      [server, apiServer].map(
        async (listener) =>
          await new Promise<void>((resolve, reject) =>
            listener.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
    );
  }
});
