import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { UnlocalhostError } from "./errors.js";
import { type ResolvedEndpoint, projectEndpoints } from "./endpoints.js";
import { ensureDir, exists, writeAtomic } from "./files.js";
import { pathsFor } from "./paths.js";
import { endpointLocalUrl } from "./urls.js";
import type { EndpointStatus, GlobalConfig, ProjectConfig } from "./types.js";

interface RunnerMetadata {
  project_id: string;
  endpoint_id: string;
  pid: number;
  command: string[];
  port: number;
  started_at: string;
}

function metadataFile(home: string, projectId: string, endpointId: string): string {
  return path.join(pathsFor(home).run, `${projectId}--${endpointId}.json`);
}

function logFiles(home: string, projectId: string, endpointId: string): {
  stdout: string;
  stderr: string;
} {
  const directory = path.join(pathsFor(home).logs, "projects", projectId);
  return {
    stdout: path.join(directory, `${endpointId}.out.log`),
    stderr: path.join(directory, `${endpointId}.err.log`),
  };
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readMetadata(
  home: string,
  projectId: string,
  endpointId: string,
): Promise<RunnerMetadata | null> {
  const file = metadataFile(home, projectId, endpointId);
  if (!(await exists(file))) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as RunnerMetadata;
    if (!Number.isInteger(parsed.pid) || parsed.pid < 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function endpointRunnerStatus(
  home: string,
  project: ProjectConfig,
  endpoint: ResolvedEndpoint,
): Promise<EndpointStatus["process"]> {
  const metadata = await readMetadata(home, project.id, endpoint.id);
  const logs = logFiles(home, project.id, endpoint.id);
  const running = metadata ? processRunning(metadata.pid) : false;
  if (metadata && !running) {
    await fs.rm(metadataFile(home, project.id, endpoint.id), { force: true });
  }
  return {
    configured: Boolean(endpoint.run_command),
    running,
    pid: running ? metadata!.pid : null,
    command: running ? metadata!.command : endpoint.run_command ?? null,
    stdout_log: endpoint.run_command ? logs.stdout : null,
    stderr_log: endpoint.run_command ? logs.stderr : null,
  };
}

async function startEndpoint(
  home: string,
  config: GlobalConfig,
  project: ProjectConfig,
  endpoint: ResolvedEndpoint,
): Promise<{ endpoint: string; pid: number; already_running: boolean }> {
  if (!endpoint.run_command) {
    throw new UnlocalhostError(
      `Endpoint "${project.id}/${endpoint.id}" has no run command; use "unlocalhost endpoint set-command ${project.id} ${endpoint.id} <command...>"`,
    );
  }
  const existing = await readMetadata(home, project.id, endpoint.id);
  if (existing && processRunning(existing.pid)) {
    return { endpoint: endpoint.id, pid: existing.pid, already_running: true };
  }
  const [command, ...args] = endpoint.run_command;
  if (!command) throw new UnlocalhostError(`Endpoint "${project.id}/${endpoint.id}" has an empty command`);
  const logs = logFiles(home, project.id, endpoint.id);
  await Promise.all([
    ensureDir(pathsFor(home).run),
    ensureDir(path.dirname(logs.stdout)),
  ]);
  const [stdout, stderr] = await Promise.all([
    fs.open(logs.stdout, "a", 0o600),
    fs.open(logs.stderr, "a", 0o600),
  ]);
  let child;
  try {
    child = spawn(command, args, {
      cwd: project.path,
      detached: true,
      env: {
        ...process.env,
        HOST: endpoint.upstream.host,
        PORT: String(endpoint.upstream.port),
        UNLOCALHOST_PROJECT: project.id,
        UNLOCALHOST_ENDPOINT: endpoint.id,
        UNLOCALHOST_PORT: String(endpoint.upstream.port),
        UNLOCALHOST_URL: endpointLocalUrl(endpoint, config),
      },
      stdio: ["ignore", stdout.fd, stderr.fd],
    });
    await new Promise<void>((resolve, reject) => {
      child!.once("spawn", resolve);
      child!.once("error", reject);
    });
  } catch (error) {
    throw new UnlocalhostError(
      `Cannot start "${endpoint.run_command.join(" ")}" for ${project.id}/${endpoint.id}: ${String(error)}`,
    );
  } finally {
    await Promise.all([stdout.close(), stderr.close()]);
  }
  child.unref();
  const metadata: RunnerMetadata = {
    project_id: project.id,
    endpoint_id: endpoint.id,
    pid: child.pid!,
    command: endpoint.run_command,
    port: endpoint.upstream.port,
    started_at: new Date().toISOString(),
  };
  await writeAtomic(
    metadataFile(home, project.id, endpoint.id),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (!processRunning(child.pid!)) {
    await fs.rm(metadataFile(home, project.id, endpoint.id), { force: true });
    throw new UnlocalhostError(
      `Process for ${project.id}/${endpoint.id} exited immediately; inspect ${logs.stderr}`,
    );
  }
  return { endpoint: endpoint.id, pid: child.pid!, already_running: false };
}

export async function startProjectRunners(
  home: string,
  config: GlobalConfig,
  project: ProjectConfig,
): Promise<Array<{ endpoint: string; pid: number; already_running: boolean }>> {
  const configured = projectEndpoints(project).filter((endpoint) => endpoint.run_command);
  if (configured.length === 0) {
    throw new UnlocalhostError(
      `Project "${project.id}" has no run commands; set one or manage its processes externally`,
    );
  }
  return await Promise.all(
    configured.map(
      async (endpoint) => await startEndpoint(home, config, project, endpoint),
    ),
  );
}

async function waitForExit(pid: number, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (!processRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !processRunning(pid);
}

async function stopEndpoint(
  home: string,
  project: ProjectConfig,
  endpoint: ResolvedEndpoint,
): Promise<{ endpoint: string; stopped: boolean }> {
  const metadata = await readMetadata(home, project.id, endpoint.id);
  if (!metadata || !processRunning(metadata.pid)) {
    await fs.rm(metadataFile(home, project.id, endpoint.id), { force: true });
    return { endpoint: endpoint.id, stopped: false };
  }
  try {
    if (process.platform === "win32") {
      process.kill(metadata.pid, "SIGTERM");
    } else {
      process.kill(-metadata.pid, "SIGTERM");
    }
  } catch {
    process.kill(metadata.pid, "SIGTERM");
  }
  if (!(await waitForExit(metadata.pid, 3000))) {
    try {
      if (process.platform === "win32") process.kill(metadata.pid, "SIGKILL");
      else process.kill(-metadata.pid, "SIGKILL");
    } catch {
      process.kill(metadata.pid, "SIGKILL");
    }
    await waitForExit(metadata.pid, 1000);
  }
  await fs.rm(metadataFile(home, project.id, endpoint.id), { force: true });
  return { endpoint: endpoint.id, stopped: true };
}

export async function stopEndpointRunner(
  home: string,
  project: ProjectConfig,
  endpoint: ResolvedEndpoint,
): Promise<{ endpoint: string; stopped: boolean }> {
  return await stopEndpoint(home, project, endpoint);
}

export async function stopProjectRunners(
  home: string,
  project: ProjectConfig,
): Promise<Array<{ endpoint: string; stopped: boolean }>> {
  return await Promise.all(
    projectEndpoints(project).map(
      async (endpoint) => await stopEndpoint(home, project, endpoint),
    ),
  );
}

export async function readEndpointLogs(
  home: string,
  projectId: string,
  endpointId: string,
  stream: "stdout" | "stderr",
  lines: number,
): Promise<string> {
  const file = logFiles(home, projectId, endpointId)[stream];
  if (!(await exists(file))) {
    throw new UnlocalhostError(`No ${stream} log exists for ${projectId}/${endpointId}`);
  }
  const content = await fs.readFile(file, "utf8");
  return content.split(/\r?\n/).slice(-lines - 1).join("\n").replace(/^\n/, "");
}
