import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runCompose } from "../src/compose.js";
import { initializeHome } from "../src/config.js";
import { addEndpoint, addProject } from "../src/registry.js";

const execFileAsync = promisify(execFile);

async function git(project: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", project, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "unlocalhost test",
      GIT_AUTHOR_EMAIL: "unlocalhost@example.invalid",
      GIT_COMMITTER_NAME: "unlocalhost test",
      GIT_COMMITTER_EMAIL: "unlocalhost@example.invalid",
    },
  });
  return result.stdout.trim();
}

test("add and Compose up leave the project git tree clean", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "unlocalhost-clean-"));
  const home = path.join(root, "state");
  const projectPath = path.join(root, "team-project");
  const fakeBin = path.join(root, "bin");
  const dockerLog = path.join(root, "docker-args.txt");
  await Promise.all([
    fs.mkdir(projectPath, { recursive: true }),
    fs.mkdir(fakeBin, { recursive: true }),
  ]);
  await fs.writeFile(
    path.join(projectPath, "compose.yml"),
    "services:\n  web:\n    image: example.invalid/team/app\n",
  );
  await fs.writeFile(path.join(projectPath, "README.md"), "team-owned repository\n");
  await git(projectPath, ["init", "-b", "main"]);
  await git(projectPath, ["add", "."]);
  await git(projectPath, ["commit", "-m", "seed"]);
  assert.equal(await git(projectPath, ["status", "--porcelain"]), "");

  await initializeHome(home, { port_range_start: 18083, port_range_end: 18090 });
  const project = await addProject(home, {
    path: projectPath,
    slug: "team-app",
    compose: "compose.yml",
    composePortServices: ["web"],
    service: "web",
    containerPort: 80,
  });
  assert.equal(await git(projectPath, ["status", "--porcelain"]), "");
  assert.ok(project.compose_override);
  assert.equal(path.dirname(project.compose_override!), path.join(home, "overrides"));
  assert.match(await fs.readFile(project.compose_override!, "utf8"), /127\.0\.0\.1:18083:80/);
  assert.match(await fs.readFile(project.compose_override!, "utf8"), /ports: !override/);
  await addEndpoint(home, "team-app", {
    id: "api",
    service: "web",
    containerPort: 3000,
  });
  assert.equal(await git(projectPath, ["status", "--porcelain"]), "");
  assert.match(await fs.readFile(project.compose_override!, "utf8"), /127\.0\.0\.1:18084:3000/);

  const fakeDocker = path.join(fakeBin, "docker");
  await fs.writeFile(
    fakeDocker,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\nif [ "$1" = "compose" ] && [ "$2" = "version" ]; then printf "2.40.3\\n"; exit 0; fi\nprintf "%s\\n" "$@" > "$UNLOCALHOST_TEST_DOCKER_LOG"\n',
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  const previousLog = process.env.UNLOCALHOST_TEST_DOCKER_LOG;
  process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ""}`;
  process.env.UNLOCALHOST_TEST_DOCKER_LOG = dockerLog;
  try {
    await runCompose(home, project, "up");
  } finally {
    process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.UNLOCALHOST_TEST_DOCKER_LOG;
    else process.env.UNLOCALHOST_TEST_DOCKER_LOG = previousLog;
  }

  assert.equal(await git(projectPath, ["status", "--porcelain"]), "");
  const dockerArgs = await fs.readFile(dockerLog, "utf8");
  assert.match(dockerArgs, new RegExp(`-f\\n${projectPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/compose\\.yml`));
  assert.match(dockerArgs, new RegExp(`-f\\n${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/overrides/team-app\\.yml`));
  assert.match(dockerArgs, /up\n-d\n$/);
});

test(
  "the external override replaces original host ports instead of merging them",
  { skip: spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status !== 0 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "unlocalhost-port-replace-"));
    const home = path.join(root, "state");
    const projectPath = path.join(root, "project");
    await fs.mkdir(projectPath);
    await fs.writeFile(
      path.join(projectPath, "compose.yml"),
      [
        "services:",
        "  web:",
        "    image: example.invalid/web",
        "    ports:",
        '      - "80:80"',
        '      - "5173:5173"',
        "  database:",
        "    image: example.invalid/database",
        "    ports:",
        '      - "3306:3306"',
        "",
      ].join("\n"),
    );
    await initializeHome(home, {
      port_range_start: 19200,
      port_range_end: 19210,
    });
    const project = await addProject(home, {
      path: projectPath,
      slug: "replace-ports",
      compose: "compose.yml",
      composePortServices: ["web", "database"],
      service: "web",
      containerPort: 80,
    });
    const merged = await execFileAsync(
      "docker",
      [
        "compose",
        "--project-directory",
        projectPath,
        "-f",
        path.join(projectPath, "compose.yml"),
        "-f",
        project.compose_override!,
        "config",
        "--format",
        "json",
      ],
      { encoding: "utf8" },
    );
    const config = JSON.parse(merged.stdout) as {
      services: Record<string, { ports?: Array<Record<string, unknown>> }>;
    };
    assert.deepEqual(config.services.web?.ports, [
      {
        mode: "ingress",
        host_ip: "127.0.0.1",
        target: 80,
        published: "19200",
        protocol: "tcp",
      },
    ]);
    assert.equal(config.services.database?.ports, undefined);
  },
);
