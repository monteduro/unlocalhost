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
  startProjectRunners,
  stopProjectRunners,
} from "../src/runner.js";

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
