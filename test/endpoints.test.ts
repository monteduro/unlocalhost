import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeHome } from "../src/config.js";
import { projectEndpoints } from "../src/endpoints.js";
import {
  addEndpoint,
  addProject,
  getProject,
  removeEndpoint,
} from "../src/registry.js";

test("secondary endpoints are grouped under one project and persist", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "unlocalhost-endpoints-"));
  const home = path.join(root, "state");
  const projectPath = path.join(root, "app");
  await fs.mkdir(projectPath);
  await initializeHome(home);
  await addProject(home, {
    path: projectPath,
    slug: "my-app",
    port: 13000,
  });
  const endpoint = await addEndpoint(home, "my-app", {
    id: "api",
    port: 14000,
  });
  assert.equal(endpoint.slug, "my-app-api");

  const stored = await getProject(home, "my-app");
  assert.deepEqual(
    projectEndpoints(stored).map((item) => ({
      id: item.id,
      slug: item.slug,
      port: item.upstream.port,
    })),
    [
      { id: "web", slug: "my-app", port: 13000 },
      { id: "api", slug: "my-app-api", port: 14000 },
    ],
  );

  await assert.rejects(
    async () =>
      await addEndpoint(home, "my-app", {
        id: "admin",
        port: 14000,
      }),
    /already used/,
  );
  await assert.rejects(
    async () => await removeEndpoint(home, "my-app", "web"),
    /cannot be removed/,
  );
  assert.equal((await removeEndpoint(home, "my-app", "api")).id, "api");
  assert.equal((await getProject(home, "my-app")).endpoints.length, 0);
});

test("Compose projects can allocate a host-process endpoint automatically", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "unlocalhost-compose-endpoint-"));
  const home = path.join(root, "state");
  const projectPath = path.join(root, "app");
  await fs.mkdir(projectPath);
  await fs.writeFile(
    path.join(projectPath, "compose.yml"),
    "services:\n  web:\n    image: nginx\n",
  );
  await initializeHome(home);
  await addProject(home, {
    path: projectPath,
    slug: "compose-app",
    port: 13000,
    compose: "compose.yml",
  });

  const endpoint = await addEndpoint(home, "compose-app", { id: "vite" });

  assert.equal(endpoint.slug, "compose-app-vite");
  assert.equal(endpoint.upstream.host, "127.0.0.1");
  assert.ok(endpoint.upstream.port >= 12000);
  assert.notEqual(endpoint.upstream.port, 13000);
  assert.equal(endpoint.compose_service, undefined);
});
