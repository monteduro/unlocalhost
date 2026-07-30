import net from "node:net";
import { validateCaddyfile } from "./caddy.js";
import { dependencyHelp, type Dependency } from "./dependencies.js";
import { errorMessage } from "./errors.js";
import { exists } from "./files.js";
import { pathsFor } from "./paths.js";
import { commandExists, runCommand } from "./process.js";
import { listProjects } from "./registry.js";
import { serviceRunning } from "./services.js";
import type { GlobalConfig } from "./types.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
}

async function commandCheck(
  name: string,
  required: boolean,
  args = ["--version"],
): Promise<DoctorCheck> {
  if (!commandExists(name)) {
    return {
      name,
      ok: false,
      required,
      detail: dependencyHelp(name as Dependency),
    };
  }
  const result = await runCommand(name, args);
  return {
    name,
    ok: result.code === 0,
    required,
    detail: result.stdout.split(/\r?\n/, 1)[0] || result.stderr.split(/\r?\n/, 1)[0] || "available",
  };
}

async function portAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function runDoctor(home: string, config: GlobalConfig): Promise<DoctorCheck[]> {
  const projects = await listProjects(home);
  const hasCompose = projects.some((project) => Boolean(project.compose_file));
  const checks = await Promise.all([
    commandCheck("caddy", true),
    commandCheck("docker", hasCompose),
    commandCheck("cloudflared", config.tunnel_enabled),
  ]);
  if (hasCompose && commandExists("docker")) {
    const result = await runCommand("docker", ["info", "--format", "{{json .ServerVersion}}"]);
    checks.push({
      name: "docker-daemon",
      ok: result.code === 0,
      required: true,
      detail: result.code === 0 ? result.stdout : result.stderr || "Docker daemon is not running",
    });
  }
  const proxyRunning = await serviceRunning(home, "proxy");
  for (const [name, port] of [
    ["caddy-http-port", config.caddy_http_port],
    ["caddy-https-port", config.caddy_https_port],
  ] as const) {
    const available = await portAvailable(port);
    checks.push({
      name,
      ok: available || proxyRunning,
      required: true,
      detail: available
        ? `127.0.0.1:${port} is available`
        : proxyRunning
          ? `127.0.0.1:${port} is used by the running proxy`
          : `127.0.0.1:${port} is already in use`,
    });
  }
  const caddyfile = pathsFor(home).caddyfile;
  if (await exists(caddyfile)) {
    try {
      await validateCaddyfile(home);
      checks.push({ name: "caddy-config", ok: true, required: true, detail: "valid" });
    } catch (error) {
      checks.push({
        name: "caddy-config",
        ok: false,
        required: true,
        detail: errorMessage(error),
      });
    }
  } else {
    checks.push({
      name: "caddy-config",
      ok: false,
      required: true,
      detail: 'missing; run "unlocalhost caddy rebuild"',
    });
  }
  return checks;
}
