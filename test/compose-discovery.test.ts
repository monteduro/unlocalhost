import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  parseComposeCandidates,
  parsePublishedServices,
  selectComposeCandidateNumbers,
  selectComposeCandidates,
} from "../src/compose-discovery.js";
import { initializeHome } from "../src/config.js";
import { projectEndpoints } from "../src/endpoints.js";
import { getProject } from "../src/registry.js";

const execFileAsync = promisify(execFile);

const composeJson = {
  services: {
    frontend: {
      ports: [{ mode: "ingress", target: 3000, protocol: "tcp" }],
    },
    api: { expose: ["4000"] },
    database: {
      ports: [{ mode: "ingress", target: 5432, protocol: "tcp" }],
    },
    metrics: {
      ports: [
        { target: 9090, protocol: "tcp" },
        { target: 9090, protocol: "tcp" },
        { target: 9091, protocol: "udp" },
      ],
    },
  },
};

test("Compose candidates include declared TCP ports and expose entries", () => {
  assert.deepEqual(parseComposeCandidates(composeJson), [
    { service: "frontend", containerPort: 3000, source: "ports" },
    { service: "api", containerPort: 4000, source: "expose" },
    { service: "database", containerPort: 5432, source: "ports" },
    { service: "metrics", containerPort: 9090, source: "ports" },
  ]);
  assert.deepEqual(parsePublishedServices(composeJson), [
    "frontend",
    "database",
    "metrics",
  ]);
});

test("Compose selections preserve primary order and require a port when ambiguous", () => {
  const candidates = parseComposeCandidates({
    services: {
      web: { expose: ["3000", "3001"] },
      api: { expose: ["4000"] },
    },
  });
  assert.deepEqual(selectComposeCandidates(candidates, "api,web:3001"), [
    { service: "api", containerPort: 4000, source: "expose" },
    { service: "web", containerPort: 3001, source: "expose" },
  ]);
  assert.deepEqual(selectComposeCandidateNumbers(candidates, "3,1"), [
    { service: "api", containerPort: 4000, source: "expose" },
    { service: "web", containerPort: 3000, source: "expose" },
  ]);
  assert.throws(() => selectComposeCandidates(candidates, "web"), /multiple ports/);
});

test("add auto-detects Compose and registers selected services without touching the project", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "unlocalhost-discovery-"));
  const home = path.join(root, "state");
  const projectPath = path.join(root, "app");
  const fakeBin = path.join(root, "bin");
  await Promise.all([
    fs.mkdir(projectPath, { recursive: true }),
    fs.mkdir(fakeBin, { recursive: true }),
  ]);
  const composeFile = path.join(projectPath, "compose.yml");
  await fs.copyFile(
    path.join(process.cwd(), "test", "fixtures", "compose-discovery.yml"),
    composeFile,
  );
  await initializeHome(home, { port_range_start: 19100, port_range_end: 19110 });

  const fakeDocker = path.join(fakeBin, "docker");
  await fs.writeFile(
    fakeDocker,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\n' 'Docker version test'
  exit 0
fi
printf '%s\n' "$UNLOCALHOST_TEST_COMPOSE_JSON"
`,
    { mode: 0o755 },
  );

  const before = await fs.readFile(composeFile, "utf8");
  const cliArgs = [
    "--import",
    "tsx",
    path.join(process.cwd(), "src", "cli.ts"),
    "--home",
    home,
    "add",
    projectPath,
  ];
  const childEnvironment = {
    ...process.env,
    PATH: fakeBin,
    UNLOCALHOST_TEST_COMPOSE_JSON: JSON.stringify(composeJson),
  };
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [...cliArgs, "--slug", "ambiguous"],
      { cwd: process.cwd(), encoding: "utf8", env: childEnvironment },
    ),
    (error: unknown) => {
      const stderr =
        typeof error === "object" &&
        error !== null &&
        "stderr" in error &&
        typeof error.stderr === "string"
          ? error.stderr
          : "";
      assert.match(stderr, /Multiple Compose endpoints were found/);
      assert.match(stderr, /--services <service,\.\.\.>/);
      return true;
    },
  );

  const result = await execFileAsync(
    process.execPath,
    [
      ...cliArgs,
      "--slug",
      "demo",
      "--services",
      "frontend,api",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: childEnvironment,
    },
  );
  assert.match(result.stdout, /web: .* → 127\.0\.0\.1:19100 → frontend:3000/);
  assert.match(result.stdout, /api: .* → 127\.0\.0\.1:19101 → api:4000/);

  const project = await getProject(home, "demo");
  assert.deepEqual(
    projectEndpoints(project).map((endpoint) => ({
      id: endpoint.id,
      service: endpoint.compose_service,
      containerPort: endpoint.container_port,
      hostPort: endpoint.upstream.port,
    })),
    [
      { id: "web", service: "frontend", containerPort: 3000, hostPort: 19100 },
      { id: "api", service: "api", containerPort: 4000, hostPort: 19101 },
    ],
  );
  assert.equal(await fs.readFile(composeFile, "utf8"), before);
  const override = await fs.readFile(
    path.join(home, "overrides", "demo.yml"),
    "utf8",
  );
  assert.match(override, /ports: !override/);
  assert.match(override, /127\.0\.0\.1:19101:4000/);
  assert.match(override, /database:\n    ports: !override \[\]/);
  assert.deepEqual(project.compose_port_services, [
    "frontend",
    "database",
    "metrics",
  ]);

  const automatic = await execFileAsync(
    process.execPath,
    [...cliArgs, "--slug", "automatic"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...childEnvironment,
        UNLOCALHOST_TEST_COMPOSE_JSON: JSON.stringify({
          services: { frontend: composeJson.services.frontend },
        }),
      },
    },
  );
  assert.match(automatic.stdout, /web: .* → 127\.0\.0\.1:19102 → frontend:3000/);
});
