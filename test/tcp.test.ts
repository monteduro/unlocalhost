import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateCaddyfile } from "../src/caddy.js";
import { initializeHome } from "../src/config.js";
import {
  addEndpoint,
  addProject,
  addTcpBinding,
  getProject,
  removeTcpBinding,
} from "../src/registry.js";

async function composeProject(home: string, projectPath: string, slug: string, port: number) {
  await fs.mkdir(projectPath);
  await fs.writeFile(
    path.join(projectPath, "compose.yml"),
    "services:\n  web:\n    image: nginx\n  mysql:\n    image: mysql\n",
  );
  return await addProject(home, {
    path: projectPath,
    slug,
    port,
    compose: "compose.yml",
    composePortServices: ["web", "mysql"],
    service: "web",
    containerPort: 80,
  });
}

test("TCP bindings persist and share the generated Compose override", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "unlocalhost-tcp-"));
  const home = path.join(root, "state");
  await initializeHome(home);
  const project = await composeProject(home, path.join(root, "app"), "my-app", 13000);

  const binding = await addTcpBinding(home, project.id, {
    id: "mysql",
    service: "mysql",
    containerPort: 3306,
    port: 13306,
  });
  assert.deepEqual(binding, {
    id: "mysql",
    compose_service: "mysql",
    container_port: 3306,
    host: "127.0.0.1",
    port: 13306,
  });

  const stored = await getProject(home, project.id);
  assert.deepEqual(stored.tcp_bindings, [binding]);
  const override = await fs.readFile(stored.compose_override!, "utf8");
  assert.match(override, /127\.0\.0\.1:13000:80/);
  assert.match(override, /127\.0\.0\.1:13306:3306/);

  const caddy = generateCaddyfile((await initializeHome(home)).config, [stored]);
  assert.doesNotMatch(caddy, /13306/);
  assert.doesNotMatch(caddy, /tcp\/mysql/);

  const cli = path.join(process.cwd(), "src", "cli.ts");
  const portResult = spawnSync(
    process.execPath,
    ["--import", "tsx", cli, "--home", home, "port", project.id, "--tcp", "mysql"],
    { encoding: "utf8" },
  );
  assert.equal(portResult.status, 0, portResult.stderr);
  assert.equal(portResult.stdout.trim(), "13306");

  const listResult = spawnSync(
    process.execPath,
    ["--import", "tsx", cli, "--home", home, "--json", "tcp", "list", project.id],
    { encoding: "utf8" },
  );
  assert.equal(listResult.status, 0, listResult.stderr);
  const listed = JSON.parse(listResult.stdout) as { tcp_bindings: unknown[] };
  assert.equal(listed.tcp_bindings.length, 1);
});

test("TCP binding ports cannot conflict with HTTP endpoints or other projects", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "unlocalhost-tcp-conflict-"));
  const home = path.join(root, "state");
  await initializeHome(home);
  const first = await composeProject(home, path.join(root, "first"), "first", 13000);
  await addTcpBinding(home, first.id, {
    id: "mysql",
    service: "mysql",
    containerPort: 3306,
    port: 13001,
  });
  const second = await composeProject(home, path.join(root, "second"), "second", 13002);

  await assert.rejects(
    async () =>
      await addEndpoint(home, second.id, {
        id: "api",
        port: 13001,
      }),
    /already used by project "first" binding "mysql"/,
  );

  await assert.rejects(
    async () =>
      await addTcpBinding(home, second.id, {
        id: "mysql",
        service: "mysql",
        containerPort: 3306,
        port: 13001,
      }),
    /already used by project "first" TCP binding "mysql"/,
  );
  await assert.rejects(
    async () =>
      await addTcpBinding(home, second.id, {
        id: "database",
        service: "mysql",
        containerPort: 3306,
        port: 13000,
      }),
    /already used by project "first" endpoint "web"/,
  );

  const allocated = await addTcpBinding(home, second.id, {
    id: "mysql",
    service: "mysql",
    containerPort: 3306,
  });
  assert.ok(allocated.port >= 12000);
  assert.ok(![13000, 13001, 13002].includes(allocated.port));
});

test("removing a TCP binding restores the service to internal-only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "unlocalhost-tcp-remove-"));
  const home = path.join(root, "state");
  await initializeHome(home);
  const project = await composeProject(home, path.join(root, "app"), "my-app", 13000);
  await addTcpBinding(home, project.id, {
    id: "mysql",
    service: "mysql",
    containerPort: 3306,
    port: 13306,
  });

  assert.equal((await removeTcpBinding(home, project.id, "mysql")).id, "mysql");
  const stored = await getProject(home, project.id);
  assert.equal(stored.tcp_bindings, undefined);
  const override = await fs.readFile(stored.compose_override!, "utf8");
  assert.match(override, /mysql:\n    ports: !override \[\]/);
});

test("TCP bindings reject public hosts and duplicate Compose targets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "unlocalhost-tcp-validation-"));
  const home = path.join(root, "state");
  await initializeHome(home);
  const project = await composeProject(home, path.join(root, "app"), "my-app", 13000);

  await assert.rejects(
    async () =>
      await addTcpBinding(home, project.id, {
        id: "mysql",
        service: "mysql",
        containerPort: 3306,
        host: "0.0.0.0",
      }),
    /accept only 127\.0\.0\.1 or localhost/,
  );
  await addTcpBinding(home, project.id, {
    id: "mysql",
    service: "mysql",
    containerPort: 3306,
    port: 13306,
  });
  await assert.rejects(
    async () =>
      await addTcpBinding(home, project.id, {
        id: "database",
        service: "mysql",
        containerPort: 3306,
        port: 13307,
      }),
    /target "mysql:3306" is already registered/,
  );
});
