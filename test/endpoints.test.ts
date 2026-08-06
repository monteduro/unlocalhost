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
  setEndpointCommand,
  setEndpointDevServer,
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

test("Compose projects can allocate and manage a host-process endpoint", async () => {
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

  const endpoint = await addEndpoint(home, "compose-app", {
    id: "vite",
    run: ["npm", "run", "dev"],
  });

  assert.equal(endpoint.slug, "compose-app-vite");
  assert.equal(endpoint.upstream.host, "127.0.0.1");
  assert.ok(endpoint.upstream.port >= 12000);
  assert.notEqual(endpoint.upstream.port, 13000);
  assert.equal(endpoint.compose_service, undefined);
  assert.deepEqual(endpoint.run_command, ["npm", "run", "dev"]);
  assert.equal(endpoint.dev_mode, true);
});

test("explicit dev mode persists for Compose endpoints while unmarked routes stay production-like", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "unlocalhost-dev-mode-"));
  const home = path.join(root, "state");
  const projectPath = path.join(root, "app");
  await fs.mkdir(projectPath);
  await fs.writeFile(path.join(projectPath, "compose.yml"), "services:\n  web:\n    image: nginx\n");
  await initializeHome(home);

  const release = await addProject(home, {
    path: projectPath,
    slug: "release",
    port: 13000,
    compose: "compose.yml",
  });
  const devEndpoint = await addEndpoint(home, release.id, {
    id: "preview",
    port: 13001,
    dev: true,
  });

  assert.equal(release.dev_mode, undefined);
  assert.equal(devEndpoint.dev_mode, true);
  const stored = await getProject(home, release.id);
  assert.equal(stored.dev_mode, undefined);
  assert.equal(stored.endpoints[0]?.dev_mode, true);

  await setEndpointCommand(home, release.id, "preview", ["npm", "run", "preview"]);
  const managed = await getProject(home, release.id);
  assert.equal(managed.endpoints[0]?.dev_mode, true);
  assert.deepEqual(managed.endpoints[0]?.run_command, ["npm", "run", "preview"]);
});

test("development server kind persists on primary and secondary endpoints", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "unlocalhost-dev-server-"));
  const home = path.join(root, "state");
  const projectPath = path.join(root, "app");
  await fs.mkdir(projectPath);
  await initializeHome(home);
  await addProject(home, {
    path: projectPath,
    slug: "vite-app",
    port: 13000,
    dev: true,
    devServer: "vite",
  });
  await addEndpoint(home, "vite-app", {
    id: "preview",
    port: 13001,
    dev: true,
  });
  await setEndpointDevServer(home, "vite-app", "preview", "generic");

  const stored = await getProject(home, "vite-app");
  assert.equal(projectEndpoints(stored)[0]?.dev_server, "vite");
  assert.equal(projectEndpoints(stored)[1]?.dev_server, "generic");
});
