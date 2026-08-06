import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeHome } from "../src/config.js";
import { projectEndpoints } from "../src/endpoints.js";
import { allocatePort } from "../src/ports.js";
import { addProject, getProject } from "../src/registry.js";
import {
  endpointRunnerStatus,
  managedViteConfigSource,
  resolveRunCommand,
  runnerEnvironment,
  startProjectRunners,
  stopProjectRunners,
  syncLaravelViteHotFile,
} from "../src/runner.js";

test("managed Vite config wraps project config without importing project dependencies", () => {
  const source = managedViteConfigSource("/tmp/project/vite.config.ts");
  assert.match(source, /import projectConfig from "file:\/\/\/tmp\/project\/vite\.config\.ts"/);
  assert.match(source, /origin: endpoint\.origin/);
  assert.match(source, /host: endpoint\.hostname/);
  assert.doesNotMatch(source, /from "vite"|node_modules\/vite/);
});

test("runner exposes one universal endpoint contract and resolves hidden port tokens", async () => {
  const project = {
    id: "next-app",
    name: "Next app",
    path: "/tmp/next-app",
    slug: "next-app",
    enabled: true,
    public_enabled: true,
    endpoints: [],
    upstream: { mode: "host_port" as const, host: "127.0.0.1", port: 12345 },
  };
  const endpoint = { ...projectEndpoints(project)[0]! };
  const config = {
    ...(await initializeHome(
      await fs.mkdtemp(path.join(os.tmpdir(), "unlocalhost-env-")),
    )).config,
    public_domain: "dev.example.com",
    machine_alias: "studio",
  };
  const environment = runnerEnvironment(
    config,
    project,
    endpoint,
  );
  assert.equal(environment.PORT, "12345");
  assert.equal(environment.VITE_PORT, "12345");
  assert.equal(environment.UNLOCALHOST_LOCAL_URL, "https://next-app.localhost:8443");
  assert.equal(
    environment.UNLOCALHOST_PUBLIC_URL,
    "https://next-app-studio.dev.example.com",
  );
  assert.equal(
    environment.UNLOCALHOST_WS_URL,
    "wss://next-app-studio.dev.example.com",
  );
  assert.deepEqual(
    resolveRunCommand(["server", "--host", "{host}", "--port", "{port}"], {
      host: "127.0.0.1",
      port: 12345,
      localUrl: environment.UNLOCALHOST_LOCAL_URL!,
      publicUrl: environment.UNLOCALHOST_PUBLIC_URL!,
    }),
    ["server", "--host", "127.0.0.1", "--port", "12345"],
  );

  const viteProject = {
    ...project,
    id: "laravel-app",
    slug: "laravel-app",
    upstream: { mode: "host_port" as const, host: "127.0.0.1", port: 12344 },
    endpoints: [
      {
        id: "vite",
        slug: "laravel-app-vite",
        upstream: { mode: "host_port" as const, host: "127.0.0.1", port: 12346 },
      },
    ],
  };
  const viteEndpoint = projectEndpoints(viteProject).find(
    (candidate) => candidate.id === "vite",
  );
  assert.ok(viteEndpoint);
  const viteEnvironment = runnerEnvironment(config, viteProject, viteEndpoint);
  assert.equal(viteEnvironment.VITE_PORT, "12346");
  assert.equal(
    viteEnvironment.UNLOCALHOST_LOCAL_URL,
    "https://laravel-app.localhost:8443",
  );
  assert.equal(
    viteEnvironment.UNLOCALHOST_PUBLIC_URL,
    "https://laravel-app-studio.dev.example.com",
  );
  assert.equal(
    viteEnvironment.UNLOCALHOST_URL,
    "https://laravel-app-studio.dev.example.com",
  );
  assert.doesNotMatch(viteEnvironment.UNLOCALHOST_URL!, /-vite/);
});

test("Laravel's ephemeral Vite hot file announces the proxied endpoint", async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "unlocalhost-hot-"));
  await fs.mkdir(path.join(projectPath, "public"));
  await fs.writeFile(path.join(projectPath, "artisan"), "");
  await fs.writeFile(path.join(projectPath, "public", "hot"), "http://127.0.0.1:12005\n");
  const project = {
    id: "laravel-app",
    name: "Laravel app",
    path: projectPath,
    slug: "laravel-app",
    enabled: true,
    endpoints: [],
    upstream: { mode: "host_port" as const, host: "127.0.0.1", port: 12004 },
  };
  const endpoint = {
    id: "vite",
    slug: "laravel-app-vite",
    primary: false,
    upstream: { mode: "host_port" as const, host: "127.0.0.1", port: 12005 },
  };
  assert.equal(
    await syncLaravelViteHotFile(
      project,
      endpoint,
      "https://laravel-app-studio.example.com",
    ),
    true,
  );
  assert.equal(
    await fs.readFile(path.join(projectPath, "public", "hot"), "utf8"),
    "https://laravel-app-studio.example.com\n",
  );
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

test("allocator persists a free port and the generic runner owns its lifecycle", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "unlocalhost-runner-"));
  const home = path.join(root, "state");
  const projectPath = path.join(root, "app");
  await fs.mkdir(projectPath);
  const port = await freePort();
  const initialized = await initializeHome(home, {
    port_range_start: port,
    port_range_end: port,
  });
  const project = await addProject(home, {
    path: projectPath,
    slug: "runner-app",
    run: [
      process.execPath,
      "-e",
      'require("http").createServer((q,r)=>{console.log("request");r.end("runner")}).listen(Number(process.env.PORT),process.env.HOST)',
    ],
  });
  assert.equal(project.dev_mode, true);
  assert.equal(project.upstream.port, port);
  await assert.rejects(
    async () => await allocatePort(initialized.config, [project]),
    /No free port/,
  );

  try {
    const started = await startProjectRunners(home, initialized.config, project);
    assert.equal(started.length, 1);
    assert.equal(started[0]?.already_running, false);
    let response: Response | null = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        response = await fetch(`http://127.0.0.1:${port}`, {
          signal: AbortSignal.timeout(200),
        });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(response);
    assert.equal(await response.text(), "runner");
    const stored = await getProject(home, project.id);
    const status = await endpointRunnerStatus(
      home,
      stored,
      projectEndpoints(stored)[0]!,
    );
    assert.equal(status.configured, true);
    assert.equal(status.running, true);
    assert.ok(status.pid);
    const metadata = JSON.parse(
      await fs.readFile(path.join(home, "run", "runner-app--web.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(metadata.canonical_url, "https://runner-app.localhost:8443");
  } finally {
    await stopProjectRunners(home, project);
  }
  const stopped = await endpointRunnerStatus(
    home,
    project,
    projectEndpoints(project)[0]!,
  );
  assert.equal(stopped.running, false);
});
