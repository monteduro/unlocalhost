import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeHome } from "../src/config.js";
import { addEndpoint, addProject } from "../src/registry.js";
import {
  automaticComposeCandidate,
  composeDevCandidate,
  defaultSetupFeatures,
  detectProject,
  hostDevDependenciesAvailable,
  managedDevCommand,
  managedStaticCommand,
  parseSetupFeatures,
  rankedHttpCandidates,
} from "../src/setup.js";

test("setup serves a static public directory without asking for a command", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "unlocalhost-setup-static-"));
  await fs.mkdir(path.join(root, "public"));
  await fs.writeFile(path.join(root, "index.html"), "repository root");
  await fs.writeFile(path.join(root, "public", "index.html"), "public website");

  const detected = await detectProject(root);
  assert.equal(detected.staticRoot, path.join(root, "public"));
  assert.equal(detected.devCommand, null);
  assert.deepEqual(defaultSetupFeatures(detected), ["https"]);
  const command = managedStaticCommand(detected);
  assert.ok(command);
  assert.equal(command[0], process.execPath);
  assert.match(command[1]!, /dist\/static-server\.js$/);
  assert.deepEqual(command.slice(-6), [
    "--root",
    path.join(root, "public"),
    "--host",
    "{host}",
    "--port",
    "{port}",
  ]);
});

test("setup detects a Docker-free Next.js dev command", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "unlocalhost-setup-next-"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      packageManager: "pnpm@10.0.0",
      scripts: { dev: "next dev" },
      dependencies: { next: "latest" },
    }),
  );
  await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

  const detected = await detectProject(root);
  assert.equal(detected.composeFile, null);
  assert.equal(detected.devServer, "next");
  assert.deepEqual(detected.devCommand, ["pnpm", "run", "dev"]);
  assert.deepEqual(defaultSetupFeatures(detected), ["https", "dev"]);
  assert.deepEqual(managedDevCommand(detected), ["pnpm", "run", "dev"]);
});

test("setup detects Angular and creates a port-independent development command", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "unlocalhost-setup-angular-"));
  await fs.mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
  await fs.writeFile(path.join(root, "node_modules", ".bin", "ng"), "");
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      scripts: { dev: "ng serve" },
      devDependencies: { "@angular/cli": "latest" },
    }),
  );

  const detected = await detectProject(root);
  assert.equal(detected.devServer, "angular");
  assert.deepEqual(managedDevCommand(detected), [
    "npm",
    "run",
    "dev",
    "--",
    "--host",
    "{host}",
    "--port",
    "{port}",
  ]);
  assert.equal(await hostDevDependenciesAvailable(detected), true);
});

test("setup detects legacy Compose names and creates a port-independent Vite command", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "unlocalhost-setup-vite-"));
  await fs.writeFile(path.join(root, "docker-compose.yaml"), "services: {}\n");
  await fs.writeFile(path.join(root, "artisan"), "");
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "latest" } }),
  );
  const detected = await detectProject(root);
  assert.equal(detected.composeFile, "docker-compose.yaml");
  assert.equal(detected.devServer, "vite");
  assert.equal(detected.framework, "laravel");
  assert.deepEqual(managedDevCommand(detected), [
    "npm",
    "run",
    "dev",
    "--",
    "--host",
    "{host}",
    "--port",
    "{port}",
    "--strictPort",
  ]);
  assert.equal(await hostDevDependenciesAvailable(detected), false);
  await fs.mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
  await fs.writeFile(path.join(root, "node_modules", ".bin", "vite"), "");
  assert.equal(await hostDevDependenciesAvailable(detected), true);
});

test("setup filters infrastructure ports and chooses the application automatically", () => {
  const candidates = [
    { service: "laravel.test", containerPort: 80, source: "ports" as const },
    { service: "laravel.test", containerPort: 5174, source: "ports" as const },
    { service: "mysql", containerPort: 3306, source: "ports" as const },
  ];
  assert.deepEqual(rankedHttpCandidates(candidates).map((item) => item.containerPort), [80, 5174]);
  const primary = automaticComposeCandidate(candidates);
  assert.equal(primary?.containerPort, 80);
  assert.equal(composeDevCandidate(candidates, primary!, "vite")?.containerPort, 5174);
});

test("setup feature parsing supports human aliases but requires a reachable endpoint", () => {
  assert.deepEqual(parseSetupFeatures("local,hmr,tunnel"), ["https", "dev", "remote"]);
  assert.throws(() => parseSetupFeatures("dev"), /local HTTPS or remote access/);
  assert.throws(() => parseSetupFeatures("magic"), /Unknown setup feature/);
});

test("non-interactive setup checks Caddy before writing state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "unlocalhost-setup-custom-"));
  const home = path.join(root, "state");
  const unknownHome = path.join(root, "unknown-state");
  const project = path.join(root, "custom-app");
  const fakeBin = path.join(root, "bin");
  await fs.mkdir(project);
  await fs.mkdir(fakeBin);
  const fakeCaddy = path.join(fakeBin, "caddy");
  await fs.writeFile(fakeCaddy, "#!/bin/sh\nexit 0\n");
  await fs.chmod(fakeCaddy, 0o755);
  const cli = path.join(process.cwd(), "src", "cli.ts");
  const baseArgs = [
    "--import",
    "tsx",
    cli,
    "--home",
    unknownHome,
    "--yes",
    "setup",
    project,
    "--features",
    "https",
    "--no-start",
  ];
  const missing = spawnSync(process.execPath, baseArgs, {
    encoding: "utf8",
    env: { ...process.env, PATH: fakeBin },
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No standard application command was detected/);
  assert.match(missing.stderr, /--run <command\.\.\.>/);

  const configuredArgs = [...baseArgs, "--run", "node", "server.js"];
  configuredArgs[4] = home;
  const configured = spawnSync(
    process.execPath,
    configuredArgs,
    {
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
    },
  );
  assert.equal(configured.status, 1);
  assert.match(configured.stderr, /Caddy is required but was not found/);
  await assert.rejects(fs.access(home));
});

test("remote setup checks cloudflared before writing state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "unlocalhost-setup-remote-dependency-"));
  const home = path.join(root, "state");
  const project = path.join(root, "remote-app");
  const fakeBin = path.join(root, "bin");
  await Promise.all([fs.mkdir(project), fs.mkdir(fakeBin)]);
  const fakeCaddy = path.join(fakeBin, "caddy");
  await fs.writeFile(fakeCaddy, "#!/bin/sh\nexit 0\n");
  await fs.chmod(fakeCaddy, 0o755);

  const configured = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(process.cwd(), "src", "cli.ts"),
      "--home",
      home,
      "--yes",
      "setup",
      project,
      "--features",
      "https,remote",
      "--domain",
      "example.com",
      "--machine",
      "studio",
      "--no-start",
      "--run",
      "node",
      "server.js",
    ],
    { encoding: "utf8", env: { ...process.env, PATH: fakeBin } },
  );

  assert.equal(configured.status, 1);
  assert.match(configured.stderr, /cloudflared is required for public tunnels but was not found/);
  await assert.rejects(fs.access(home));
});

test("rm never calls Cloudflare and prints every DNS record for manual deletion", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "unlocalhost-rm-dns-"));
  const home = path.join(root, "state");
  const projectPath = path.join(root, "public-app");
  await fs.mkdir(projectPath);
  await initializeHome(home, {
    public_domain: "example.com",
    machine_id: "host-009-a1b2c3",
    machine_alias: "studio",
    dns_mode: "project",
    tunnel_enabled: true,
  });
  await addProject(home, {
    path: projectPath,
    slug: "public-app",
    port: 18080,
    public: true,
  });
  await addEndpoint(home, "public-app", {
    id: "vite",
    port: 18081,
  });

  const removed = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(process.cwd(), "src", "cli.ts"),
      "--home",
      home,
      "rm",
      "public-app",
    ],
    { encoding: "utf8", env: { ...process.env, PATH: "" } },
  );
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /ACTION: delete these DNS records manually/);
  assert.match(removed.stdout, /public-app-studio\.example\.com/);
  assert.doesNotMatch(removed.stdout, /public-app-vite-studio\.example\.com/);
  await assert.rejects(
    fs.access(path.join(home, "projects", "public-app.toml")),
  );
});
