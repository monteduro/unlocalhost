#!/usr/bin/env node

import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import {
  generateCaddyfile,
  maybeReloadCaddy,
  rebuildCaddyfile,
  reloadCaddy,
  validateCaddyfile,
} from "./caddy.js";
import { runCompose } from "./compose.js";
import {
  detectComposeFile,
  discoverCompose,
  formatComposeCandidates,
  selectComposeCandidateNumbers,
  selectComposeCandidates,
  type ComposeCandidate,
} from "./compose-discovery.js";
import {
  initializeHome,
  loadGlobalConfig,
  saveGlobalConfig,
  serializeProject,
} from "./config.js";
import { dependencyHelp } from "./dependencies.js";
import { runDoctor } from "./doctor.js";
import { getEndpoint, projectEndpoints } from "./endpoints.js";
import { UnlocalhostError, errorMessage } from "./errors.js";
import { exists } from "./files.js";
import { printJson, printLine, printProjectStatuses } from "./output.js";
import { pathsFor, resolveUnlocalhostHome } from "./paths.js";
import { commandExists, runCommand, runForeground } from "./process.js";
import {
  addEndpoint,
  addProject,
  getProject,
  listProjects,
  removeEndpoint,
  removeProject,
  setEndpointCommand,
} from "./registry.js";
import {
  readEndpointLogs,
  startProjectRunners,
  stopProjectRunners,
} from "./runner.js";
import {
  installService,
  serviceAction,
  serviceInstalled,
  serviceRunning,
  uninstallService,
} from "./services.js";
import { fullStatus } from "./status.js";
import { initializeTunnel, readTunnelId } from "./tunnel.js";
import {
  endpointLocalUrl,
  endpointPublicUrl,
  localUrl,
  projectEndpointUrl,
  publicUrl,
} from "./urls.js";
import type { GlobalConfig, ProjectConfig } from "./types.js";

interface GlobalOptions {
  home?: string;
  json?: boolean;
  yes?: boolean;
}

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals() as GlobalOptions;
}

function homeFor(command: Command): string {
  return resolveUnlocalhostHome(globalOptions(command).home);
}

function wantsJson(command: Command): boolean {
  return Boolean(globalOptions(command).json);
}

function emit(command: Command, human: string, data: unknown): void {
  if (wantsJson(command)) printJson(data);
  else printLine(human);
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UnlocalhostError(`Invalid port "${value}": expected an integer from 1 to 65535`);
  }
  return port;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new UnlocalhostError(`Invalid positive integer "${value}"`);
  }
  return parsed;
}

function normalizeRunCommand(value: string[] | undefined): string[] | undefined {
  if (!value) return undefined;
  if (value.length === 1 && /\s/.test(value[0]!)) {
    return process.platform === "win32"
      ? ["cmd.exe", "/d", "/s", "/c", value[0]!]
      : ["/bin/sh", "-lc", value[0]!];
  }
  return value;
}

async function chooseComposeCandidates(
  candidates: ComposeCandidate[],
  services: string | undefined,
  command: Command,
): Promise<ComposeCandidate[]> {
  if (services !== undefined) return selectComposeCandidates(candidates, services);
  if (candidates.length === 1) return candidates;

  const available = formatComposeCandidates(candidates);
  if (
    globalOptions(command).yes ||
    wantsJson(command) ||
    !process.stdin.isTTY ||
    !process.stderr.isTTY
  ) {
    throw new UnlocalhostError(
      `Multiple Compose endpoints were found:\n${available}\nChoose explicitly with --services <service,...>; use service:port when a service exposes multiple ports.`,
    );
  }

  process.stderr.write(
    `Compose endpoints found:\n${available}\nOnly select HTTP services; the first becomes the primary endpoint.\n`,
  );
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question("Select comma-separated numbers: ");
    return selectComposeCandidateNumbers(candidates, answer);
  } finally {
    prompt.close();
  }
}

function composeEndpointId(
  candidate: ComposeCandidate,
  used: Set<string>,
): string {
  let base = candidate.service
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, "");
  if (!base) base = "endpoint";
  let id = base;
  if (used.has(id)) id = `${base.slice(0, 23).replace(/-+$/g, "")}-${candidate.containerPort}`;
  for (let suffix = 2; used.has(id); suffix += 1) {
    id = `${base.slice(0, 26).replace(/-+$/g, "")}-${suffix}`;
  }
  used.add(id);
  return id;
}

function composeEndpointSlug(projectSlug: string, endpointId: string): string {
  const suffix = `-${endpointId}`;
  const prefix = projectSlug
    .slice(0, 63 - suffix.length)
    .replace(/-+$/g, "");
  return `${prefix}${suffix}`;
}

async function rebuildRoutes(home: string, config: GlobalConfig): Promise<{
  file: string;
  projectCount: number;
  reloaded: boolean;
}> {
  const rebuilt = await rebuildCaddyfile(home, config);
  return { ...rebuilt, reloaded: await maybeReloadCaddy(home) };
}

async function selectProjects(
  home: string,
  id: string | undefined,
  all: boolean | undefined,
): Promise<ProjectConfig[]> {
  if (Boolean(id) === Boolean(all)) {
    throw new UnlocalhostError('Specify exactly one project id or "--all"');
  }
  return all ? await listProjects(home) : [await getProject(home, id!)];
}

const program = new Command();
program
  .name("unlocalhost")
  .description("Develop on your own machine from anywhere.")
  .version("0.1.0-alpha.0")
  .option("--home <path>", "state directory (default: UNLOCALHOST_HOME or ~/.unlocalhost)")
  .option("--json", "emit machine-readable JSON where supported")
  .option("--yes", "accept non-interactive defaults")
  .showHelpAfterError()
  .addHelpText(
    "after",
    `
Agent-ready workflow:
  unlocalhost doctor
  unlocalhost --yes add "$PWD" --slug <slug> --services <http-service>:<container-port>
  unlocalhost up <slug>
  unlocalhost --json status <slug>
  unlocalhost url <slug> --public

One-time public setup:
  cloudflared tunnel login
  unlocalhost tunnel init --domain <domain> --name unlocalhost
  unlocalhost tunnel install
  unlocalhost proxy install

The tunnel and wildcard DNS are machine-wide; adding another project requires
no Cloudflare changes. See "unlocalhost endpoint add --help" for Vite/HMR and
GUIDE.md for the complete human and agent workflow.`,
  );

program
  .command("init")
  .description("create the external unlocalhost state directory")
  .option("--projects-root <path>", "default project discovery hint")
  .option("--domain <domain>", "public wildcard domain, without '*.'")
  .option("--account-id <id>", "Cloudflare account id")
  .option("--zone-id <id>", "Cloudflare zone id")
  .option("--http-port <port>", "Caddy loopback HTTP port", parsePort)
  .option("--https-port <port>", "Caddy local HTTPS port", parsePort)
  .action(async (options, command: Command) => {
    const home = homeFor(command);
    const overrides: Partial<GlobalConfig> = {};
    if (options.projectsRoot) overrides.default_projects_root = options.projectsRoot;
    if (options.domain) overrides.public_domain = String(options.domain).replace(/^\*\./, "");
    if (options.accountId) overrides.cloudflare_account_id = options.accountId;
    if (options.zoneId) overrides.cloudflare_zone_id = options.zoneId;
    if (options.httpPort) overrides.caddy_http_port = options.httpPort;
    if (options.httpsPort) overrides.caddy_https_port = options.httpsPort;
    const result = await initializeHome(home, overrides);
    const rebuilt = await rebuildRoutes(home, result.config);
    emit(
      command,
      result.created ? `Initialized unlocalhost at ${home}` : `unlocalhost is already initialized at ${home}`,
      { ok: true, home, created: result.created, config: result.config, caddy: rebuilt },
    );
  });

program
  .command("add")
  .description("register a project without writing inside it")
  .argument("<path>", "project directory")
  .requiredOption("--slug <slug>", "hostname-safe project id")
  .option("--port <port>", "published loopback HTTP port; allocated automatically when omitted", parsePort)
  .option("--host <host>", "upstream host", "127.0.0.1")
  .option("--name <name>", "display name")
  .option("--compose <file>", "Compose file relative to the project")
  .option("--services <selection>", "Compose HTTP services, comma-separated; service:port disambiguates")
  .option("--service <service>", "Compose service for an external port override")
  .option("--container-port <port>", "container HTTP port for the override", parsePort)
  .option("--run <command...>", "command for non-Compose projects; place this option last")
  .action(async (projectPath: string, options, command: Command) => {
    const home = homeFor(command);
    const config = await loadGlobalConfig(home);
    const run = normalizeRunCommand(options.run);
    if ((options.service && !options.containerPort) || (!options.service && options.containerPort)) {
      throw new UnlocalhostError("--service and --container-port must be provided together");
    }
    if (options.services && (options.service || options.containerPort)) {
      throw new UnlocalhostError("--services cannot be combined with --service or --container-port");
    }
    if (options.services && options.port !== undefined) {
      throw new UnlocalhostError("--services uses automatically allocated host ports and cannot be combined with --port");
    }
    if (options.services && run) {
      throw new UnlocalhostError("--services is for Compose projects and cannot be combined with --run");
    }

    const resolvedProjectPath = path.resolve(projectPath);
    const detectedCompose =
      !options.compose && !run && options.port === undefined
        ? await detectComposeFile(resolvedProjectPath)
        : null;
    const composeFile = options.compose ?? detectedCompose ?? undefined;
    const shouldDiscover =
      Boolean(options.services) ||
      (Boolean(composeFile) &&
        options.port === undefined &&
        !options.service &&
        !options.containerPort &&
        !run);

    let project: ProjectConfig;
    if (shouldDiscover) {
      const discovery = await discoverCompose(resolvedProjectPath, composeFile);
      const selected = await chooseComposeCandidates(
        discovery.candidates,
        options.services,
        command,
      );
      const primary = selected[0]!;
      project = await addProject(home, {
        path: resolvedProjectPath,
        slug: options.slug,
        host: options.host,
        name: options.name,
        compose: discovery.composeFile,
        composePortServices: discovery.publishedServices,
        service: primary.service,
        containerPort: primary.containerPort,
      });
      try {
        const usedIds = new Set(["web"]);
        for (const candidate of selected.slice(1)) {
          const id = composeEndpointId(candidate, usedIds);
          await addEndpoint(home, project.id, {
            id,
            slug: composeEndpointSlug(project.slug, id),
            host: options.host,
            service: candidate.service,
            containerPort: candidate.containerPort,
          });
        }
        project = await getProject(home, project.id);
      } catch (error) {
        await removeProject(home, project.id);
        throw error;
      }
    } else {
      project = await addProject(home, {
        path: resolvedProjectPath,
        slug: options.slug,
        port: options.port,
        host: options.host,
        name: options.name,
        compose: composeFile,
        service: options.service,
        containerPort: options.containerPort,
        ...(run ? { run } : {}),
      });
    }
    const caddy = await rebuildRoutes(home, config);
    const registeredEndpoints = projectEndpoints(project).map((endpoint) => ({
      id: endpoint.id,
      service: endpoint.compose_service ?? null,
      container_port: endpoint.container_port ?? null,
      host_port: endpoint.upstream.port,
      local_url: endpointLocalUrl(endpoint, config),
      public_url: endpointPublicUrl(endpoint, config),
    }));
    const human = [
      `Registered ${project.id}:`,
      ...registeredEndpoints.map(
        (endpoint) =>
          `  ${endpoint.id}: ${endpoint.local_url} → 127.0.0.1:${endpoint.host_port}${
            endpoint.service
              ? ` → ${endpoint.service}:${endpoint.container_port}`
              : ""
          }`,
      ),
    ].join("\n");
    emit(command, human, {
      ok: true,
      project,
      endpoints: registeredEndpoints,
      urls: { local: localUrl(project, config), public: publicUrl(project, config) },
      caddy,
    });
  });

program
  .command("rm")
  .alias("remove")
  .description("remove a registration and its generated external override")
  .argument("<id>")
  .action(async (id: string, _options, command: Command) => {
    const home = homeFor(command);
    const config = await loadGlobalConfig(home);
    const project = await removeProject(home, id);
    const caddy = await rebuildRoutes(home, config);
    emit(command, `Removed ${project.id}`, { ok: true, removed: project.id, caddy });
  });

program
  .command("list")
  .description("list registered projects")
  .action(async (_options, command: Command) => {
    const home = homeFor(command);
    const config = await loadGlobalConfig(home);
    const projects = await listProjects(home);
    const rows = projects.map((project) => ({
      id: project.id,
      name: project.name,
      path: project.path,
      upstream: `${project.upstream.host}:${project.upstream.port}`,
      local_url: localUrl(project, config),
      public_url: publicUrl(project, config),
      compose: project.compose_file ?? null,
      endpoint_count: project.endpoints.length + 1,
    }));
    if (wantsJson(command)) printJson({ schema_version: 1, home, projects: rows });
    else if (rows.length === 0) printLine("No projects registered.");
    else {
      const width = Math.max(2, ...rows.map((row) => row.id.length));
      for (const row of rows) {
        printLine(
          `${row.id.padEnd(width)}  ${row.upstream.padEnd(22)}  ${row.local_url}  (${row.endpoint_count} endpoint${row.endpoint_count === 1 ? "" : "s"})`,
        );
      }
    }
  });

program
  .command("show")
  .description("show one project registration")
  .argument("<id>")
  .action(async (id: string, _options, command: Command) => {
    const home = homeFor(command);
    const config = await loadGlobalConfig(home);
    const project = await getProject(home, id);
    if (wantsJson(command)) {
      printJson({
        schema_version: 1,
        project,
        endpoints: projectEndpoints(project).map((endpoint) => ({
          id: endpoint.id,
          slug: endpoint.slug,
          primary: endpoint.primary,
          local_url: endpointLocalUrl(endpoint, config),
          public_url: endpointPublicUrl(endpoint, config),
          upstream: `${endpoint.upstream.host}:${endpoint.upstream.port}`,
        })),
      });
    } else {
      printLine(serializeProject(project).trimEnd());
      printLine(`local_url = ${JSON.stringify(localUrl(project, config))}`);
      const remote = publicUrl(project, config);
      if (remote) printLine(`public_url = ${JSON.stringify(remote)}`);
    }
  });

const endpoint = program
  .command("endpoint")
  .description("manage multiple HTTP endpoints for one project");

endpoint
  .command("add")
  .description("add a named endpoint; its slug defaults to <project>-<name>")
  .argument("<project>", "registered project id")
  .argument("<name>", "endpoint name, for example api")
  .option("--port <port>", "published loopback HTTP port; allocated automatically when omitted", parsePort)
  .option("--slug <slug>", "custom hostname slug")
  .option("--host <host>", "upstream host", "127.0.0.1")
  .option("--service <service>", "Compose service for an external port override")
  .option("--container-port <port>", "container HTTP port for the override", parsePort)
  .option("--run <command...>", "command for non-Compose projects; place this option last")
  .addHelpText(
    "after",
    `
Examples:
  # Vite runs inside a Compose service; every container may keep port 5173.
  unlocalhost endpoint add my-app vite --service web --container-port 5173

  # Vite runs directly on the host; unlocalhost allocates the listening port.
  unlocalhost endpoint add my-app vite
  unlocalhost port my-app --endpoint vite

For public HMR, configure Vite with the generated public endpoint as
server.origin, allow the app's exact local/public origins in server.cors, and
use WSS on port 443 (server.ws in Vite 8; server.hmr in older Vite versions).
Caddy proxies the asset requests and WebSocket automatically.

For Compose projects, "unlocalhost up" starts the Compose stack but does not run an
extra npm command inside an existing service. Start that dev server exactly
once using the project's normal command. "Port already in use" inside the
container normally means it is already running there; do not allocate another
port. This also applies to Next, Webpack, and other Node HTTP dev servers.`,
  )
  .action(async (projectId: string, name: string, options, command: Command) => {
    const home = homeFor(command);
    const config = await loadGlobalConfig(home);
    const added = await addEndpoint(home, projectId, {
      id: name,
      slug: options.slug,
      port: options.port,
      host: options.host,
      service: options.service,
      containerPort: options.containerPort,
      ...(normalizeRunCommand(options.run)
        ? { run: normalizeRunCommand(options.run)! }
        : {}),
    });
    const caddy = await rebuildRoutes(home, config);
    emit(
      command,
      `Added ${projectId}/${added.id}: ${endpointLocalUrl(added, config)}`,
      {
        ok: true,
        project: projectId,
        endpoint: added,
        urls: {
          local: endpointLocalUrl(added, config),
          public: endpointPublicUrl(added, config),
        },
        caddy,
      },
    );
  });

endpoint
  .command("set-command")
  .description("set or replace the saved command for an endpoint")
  .argument("<project>")
  .argument("<name>", 'use "web" for the primary endpoint')
  .argument("<command...>")
  .action(
    async (
      projectId: string,
      name: string,
      commandParts: string[],
      _options,
      command: Command,
    ) => {
      const home = homeFor(command);
      const normalized = normalizeRunCommand(commandParts)!;
      await setEndpointCommand(home, projectId, name, normalized);
      emit(command, `Saved command for ${projectId}/${name}: ${normalized.join(" ")}`, {
        ok: true,
        project: projectId,
        endpoint: name,
        command: normalized,
      });
    },
  );

endpoint
  .command("rm")
  .alias("remove")
  .description("remove a secondary endpoint")
  .argument("<project>")
  .argument("<name>")
  .action(async (projectId: string, name: string, _options, command: Command) => {
    const home = homeFor(command);
    const config = await loadGlobalConfig(home);
    const removed = await removeEndpoint(home, projectId, name);
    const caddy = await rebuildRoutes(home, config);
    emit(command, `Removed ${projectId}/${removed.id}`, {
      ok: true,
      project: projectId,
      removed: removed.id,
      caddy,
    });
  });

endpoint
  .command("list")
  .description("list every endpoint in a project")
  .argument("<project>")
  .action(async (projectId: string, _options, command: Command) => {
    const home = homeFor(command);
    const config = await loadGlobalConfig(home);
    const project = await getProject(home, projectId);
    const endpoints = projectEndpoints(project).map((item) => ({
      id: item.id,
      slug: item.slug,
      primary: item.primary,
      upstream: `${item.upstream.host}:${item.upstream.port}`,
      local_url: endpointLocalUrl(item, config),
      public_url: endpointPublicUrl(item, config),
    }));
    if (wantsJson(command)) {
      printJson({ schema_version: 1, project: project.id, endpoints });
    } else {
      for (const item of endpoints) {
        printLine(
          `${item.id}${item.primary ? " (primary)" : ""}  ${item.upstream}  ${item.local_url}`,
        );
      }
    }
  });

async function composeOperation(
  operation: "up" | "down",
  id: string | undefined,
  options: { all?: boolean },
  command: Command,
): Promise<void> {
  const home = homeFor(command);
  const config = await loadGlobalConfig(home);
  const projects = await selectProjects(home, id, options.all);
  if (projects.length === 0) throw new UnlocalhostError("No projects are registered");
  if (
    operation === "up" &&
    projects.some(
      (project) =>
        !project.compose_file &&
        !projectEndpoints(project).some((endpoint) => endpoint.run_command),
    )
  ) {
    const missing = projects
      .filter(
        (project) =>
          !project.compose_file &&
          !projectEndpoints(project).some((endpoint) => endpoint.run_command),
      )
      .map((project) => project.id);
    throw new UnlocalhostError(
      `No run command is configured for: ${missing.join(", ")}; use "unlocalhost endpoint set-command <project> web <command...>"`,
    );
  }
  const lifecycle = await Promise.all(
    projects.map(async (project) => {
      process.stderr.write(`${operation === "up" ? "Starting" : "Stopping"} ${project.id}...\n`);
      if (project.compose_file) {
        await runCompose(home, project, operation);
        return { project: project.id, manager: "compose" };
      }
      const processes =
        operation === "up"
          ? await startProjectRunners(home, config, project)
          : await stopProjectRunners(home, project);
      return { project: project.id, manager: "runner", processes };
    }),
  );
  const caddy = await rebuildRoutes(home, config);
  emit(command, `${operation === "up" ? "Started" : "Stopped"} ${projects.map((p) => p.id).join(", ")}`, {
    ok: true,
    operation,
    projects: projects.map((project) => project.id),
    lifecycle,
    caddy,
  });
}

program
  .command("up")
  .description("start saved processes or a registered Compose project")
  .argument("[id]")
  .option("--all", "start every registered project")
  .action(async (id: string | undefined, options, command: Command) => {
    await composeOperation("up", id, options, command);
  });

program
  .command("down")
  .description("stop saved processes or a registered Compose project")
  .argument("[id]")
  .option("--all", "stop every registered project")
  .action(async (id: string | undefined, options, command: Command) => {
    await composeOperation("down", id, options, command);
  });

program
  .command("restart")
  .description("restart saved processes or a registered Compose project")
  .argument("<id>")
  .action(async (id: string, _options, command: Command) => {
    const home = homeFor(command);
    const config = await loadGlobalConfig(home);
    const project = await getProject(home, id);
    process.stderr.write(`Restarting ${project.id}...\n`);
    if (project.compose_file) {
      await runCompose(home, project, "down");
      await runCompose(home, project, "up");
    } else {
      await stopProjectRunners(home, project);
      await startProjectRunners(home, config, project);
    }
    const caddy = await rebuildRoutes(home, config);
    emit(command, `Restarted ${project.id}`, { ok: true, project: project.id, caddy });
  });

program
  .command("port")
  .description("print one allocated upstream port")
  .argument("<id>")
  .option("--endpoint <name>", 'endpoint name (default: "web")', "web")
  .action(async (id: string, options, command: Command) => {
    const project = await getProject(homeFor(command), id);
    const selected = getEndpoint(project, options.endpoint);
    if (!selected) {
      throw new UnlocalhostError(
        `Endpoint "${options.endpoint}" is not registered in project "${project.id}"`,
      );
    }
    printLine(String(selected.upstream.port));
  });

program
  .command("logs")
  .description("print saved process-runner logs")
  .argument("<id>")
  .option("--endpoint <name>", 'endpoint name (default: "web")', "web")
  .option("--stderr", "read stderr instead of stdout")
  .option("--lines <count>", "number of trailing lines", parsePositiveInteger, 100)
  .action(async (id: string, options, command: Command) => {
    const home = homeFor(command);
    const project = await getProject(home, id);
    if (!getEndpoint(project, options.endpoint)) {
      throw new UnlocalhostError(
        `Endpoint "${options.endpoint}" is not registered in project "${project.id}"`,
      );
    }
    const stream = options.stderr ? "stderr" : "stdout";
    const content = await readEndpointLogs(
      home,
      project.id,
      options.endpoint,
      stream,
      options.lines,
    );
    if (wantsJson(command)) {
      printJson({
        project: project.id,
        endpoint: options.endpoint,
        stream,
        lines: options.lines,
        content,
      });
    } else {
      process.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
    }
  });

program
  .command("status")
  .description("show Compose, proxy route, tunnel, and upstream health")
  .argument("[id]")
  .action(async (id: string | undefined, _options, command: Command) => {
    const home = homeFor(command);
    const config = await loadGlobalConfig(home);
    const status = await fullStatus(home, config, id);
    if (wantsJson(command)) printJson(status);
    else {
      const proxy = status.proxy as Record<string, boolean>;
      const tunnel = status.tunnel as Record<string, unknown>;
      printLine(`Proxy: ${proxy.running ? "running" : proxy.installed ? "installed, stopped" : "not installed"}`);
      printLine(
        `Tunnel: ${
          tunnel.running
            ? "running"
            : tunnel.installed
              ? "installed, stopped"
              : tunnel.enabled
                ? "enabled, not installed"
                : "disabled"
        }`,
      );
      printProjectStatuses(status.projects as import("./types.js").ProjectStatus[]);
    }
  });

program
  .command("url")
  .description("print one capture-friendly URL")
  .argument("<id>")
  .option("--local", "print the local URL")
  .option("--public", "print the public URL")
  .option("--endpoint <name>", 'endpoint name (default: "web")', "web")
  .action(async (id: string, options, command: Command) => {
    if (options.local && options.public) {
      throw new UnlocalhostError("Choose only one of --local or --public");
    }
    const home = homeFor(command);
    const config = await loadGlobalConfig(home);
    const project = await getProject(home, id);
    const url = projectEndpointUrl(
      project,
      config,
      options.endpoint,
      Boolean(options.public),
    );
    if (!url) throw new UnlocalhostError("public_domain is not configured");
    // Intentionally never wraps the URL: agents can capture stdout directly.
    printLine(url);
  });

const caddy = program.command("caddy").description("generate Caddy configuration");
caddy
  .command("rebuild")
  .description("regenerate the Caddyfile and reload a running proxy")
  .action(async (_options, command: Command) => {
    const home = homeFor(command);
    const config = await loadGlobalConfig(home);
    const result = await rebuildRoutes(home, config);
    emit(command, `Generated ${result.file} for ${result.projectCount} project(s)`, {
      ok: true,
      ...result,
    });
  });

const proxy = program.command("proxy").description("manage the supervised Caddy proxy");
proxy
  .command("install")
  .description("install and start the user service")
  .action(async (_options, command: Command) => {
    const home = homeFor(command);
    const config = await loadGlobalConfig(home);
    await rebuildCaddyfile(home, config);
    await validateCaddyfile(home);
    const file = await installService(home, "proxy");
    emit(command, `Installed and started proxy service: ${file}`, { ok: true, installed: true, file });
  });
proxy
  .command("uninstall")
  .description("stop and remove the user service")
  .action(async (_options, command: Command) => {
    const home = homeFor(command);
    const file = await uninstallService(home, "proxy");
    emit(command, `Uninstalled proxy service: ${file}`, { ok: true, installed: false, file });
  });
for (const action of ["start", "stop"] as const) {
  proxy
    .command(action)
    .description(`${action} the proxy user service`)
    .action(async (_options, command: Command) => {
      const home = homeFor(command);
      await serviceAction(home, "proxy", action);
      emit(command, `Proxy ${action === "start" ? "started" : "stopped"}`, {
        ok: true,
        action,
      });
    });
}
proxy
  .command("reload")
  .description("validate and reload Caddy configuration")
  .action(async (_options, command: Command) => {
    const home = homeFor(command);
    const config = await loadGlobalConfig(home);
    await rebuildCaddyfile(home, config);
    await reloadCaddy(home);
    emit(command, "Proxy reloaded", { ok: true, reloaded: true });
  });
proxy
  .command("status")
  .description("show proxy service state")
  .action(async (_options, command: Command) => {
    const home = homeFor(command);
    const result = {
      installed: await serviceInstalled(home, "proxy"),
      running: await serviceRunning(home, "proxy"),
      caddyfile: pathsFor(home).caddyfile,
    };
    emit(
      command,
      result.running ? "Proxy is running" : result.installed ? "Proxy is installed but stopped" : "Proxy is not installed",
      result,
    );
  });
proxy
  .command("run")
  .description("run Caddy in the foreground for development")
  .action(async (_options, command: Command) => {
    const home = homeFor(command);
    const config = await loadGlobalConfig(home);
    await rebuildCaddyfile(home, config);
    await validateCaddyfile(home);
    process.exitCode = await runForeground("caddy", [
      "run",
      "--config",
      pathsFor(home).caddyfile,
      "--adapter",
      "caddyfile",
    ]);
  });

const tunnel = program.command("tunnel").description("manage one optional Cloudflare tunnel");
tunnel
  .command("guide")
  .description("print the wildcard-only setup guide")
  .action((_options, command: Command) => {
    const home = homeFor(command);
    const guide = [
      "1. Put the domain on Cloudflare.",
      "2. Run: cloudflared tunnel login",
      "3. Run: unlocalhost tunnel init --domain <domain> --name unlocalhost",
      "4. Run: unlocalhost tunnel install",
      "5. Run: unlocalhost proxy install",
      "6. Run once for local HTTPS trust: caddy trust",
      "7. Register projects with unlocalhost add; no further Cloudflare or DNS command is needed.",
      "",
      `Generated tunnel state and public_domain are stored under ${home}; project URLs become <slug>.<public_domain>.`,
      "Automation alternative: set CLOUDFLARE_API_TOKEN and pass --account-id plus --zone-id.",
      "The token needs Account: Cloudflare Tunnel and Zone: DNS Edit.",
      "Only one proxied wildcard CNAME is created; no per-project DNS records are used.",
      "Free Universal SSL on a full zone covers only first-level subdomains; nested names need additional certificate coverage.",
    ].join("\n");
    if (wantsJson(command)) printJson({ home, guide: guide.split("\n") });
    else printLine(guide);
  });
tunnel
  .command("init")
  .description("create/reuse one named tunnel and ensure wildcard DNS")
  .option("--domain <domain>", "public domain, without '*.'")
  .option("--name <name>", "tunnel name")
  .option("--account-id <id>", "Cloudflare account id for API-token setup")
  .option("--zone-id <id>", "Cloudflare zone id for API-token setup")
  .action(async (options, command: Command) => {
    const home = homeFor(command);
    const current = await loadGlobalConfig(home);
    const next: GlobalConfig = {
      ...current,
      ...(options.domain ? { public_domain: String(options.domain).replace(/^\*\./, "") } : {}),
      ...(options.name ? { tunnel_name: options.name } : {}),
      ...(options.accountId ? { cloudflare_account_id: options.accountId } : {}),
      ...(options.zoneId ? { cloudflare_zone_id: options.zoneId } : {}),
      tunnel_enabled: true,
    };
    const result = await initializeTunnel(home, next);
    await saveGlobalConfig(home, next);
    await rebuildRoutes(home, next);
    emit(
      command,
      `Tunnel ${result.tunnel.name} ready; wildcard DNS ${result.dns}`,
      { ok: true, ...result, wildcard: `*.${next.public_domain}` },
    );
  });
tunnel
  .command("install")
  .description("install and start the supervised tunnel user service")
  .action(async (_options, command: Command) => {
    const home = homeFor(command);
    await loadGlobalConfig(home);
    if (!commandExists("cloudflared")) {
      throw new UnlocalhostError(dependencyHelp("cloudflared"));
    }
    const id = await readTunnelId(home);
    const file = await installService(home, "tunnel", id);
    emit(command, `Installed and started tunnel service: ${file}`, {
      ok: true,
      installed: true,
      tunnel_id: id,
      file,
    });
  });
tunnel
  .command("uninstall")
  .description("stop and remove the tunnel user service")
  .action(async (_options, command: Command) => {
    const home = homeFor(command);
    const id = await readTunnelId(home);
    const file = await uninstallService(home, "tunnel", id);
    emit(command, `Uninstalled tunnel service: ${file}`, { ok: true, installed: false, file });
  });
for (const action of ["start", "stop"] as const) {
  tunnel
    .command(action)
    .description(`${action} the tunnel user service`)
    .action(async (_options, command: Command) => {
      const home = homeFor(command);
      const id = await readTunnelId(home);
      await serviceAction(home, "tunnel", action, id);
      emit(command, `Tunnel ${action === "start" ? "started" : "stopped"}`, {
        ok: true,
        action,
        tunnel_id: id,
      });
    });
}
tunnel
  .command("status")
  .description("show tunnel service state")
  .action(async (_options, command: Command) => {
    const home = homeFor(command);
    let id: string | null = null;
    try {
      id = await readTunnelId(home);
    } catch {
      // Report an unconfigured optional tunnel rather than failing.
    }
    const result = {
      configured: id !== null,
      tunnel_id: id,
      installed: id ? await serviceInstalled(home, "tunnel", id) : false,
      running: id ? await serviceRunning(home, "tunnel", id) : false,
    };
    emit(command, result.running ? "Tunnel is running" : result.configured ? "Tunnel is stopped" : "Tunnel is not initialized", result);
  });
tunnel
  .command("open-dashboard")
  .description("open the Cloudflare Zero Trust tunnel dashboard")
  .action(async (_options, command: Command) => {
    const url = "https://one.dash.cloudflare.com/";
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    const result = await runCommand(opener, [url]);
    if (result.code !== 0) throw new UnlocalhostError(`Could not open ${url}: ${result.stderr}`);
    emit(command, `Opened ${url}`, { ok: true, url });
  });

program
  .command("doctor")
  .description("check dependencies, ports, services, and generated configuration")
  .action(async (_options, command: Command) => {
    const home = homeFor(command);
    const config = await loadGlobalConfig(home);
    const checks = await runDoctor(home, config);
    const ok = checks.every((check) => check.ok || !check.required);
    if (wantsJson(command)) printJson({ schema_version: 1, ok, checks });
    else {
      for (const check of checks) {
        printLine(`${check.ok ? "ok" : check.required ? "FAIL" : "warn"}  ${check.name}: ${check.detail}`);
      }
    }
    if (!ok) process.exitCode = 1;
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const global = program.opts() as GlobalOptions;
  if (global.json) {
    printJson({
      ok: false,
      error: errorMessage(error),
      code: error instanceof UnlocalhostError ? error.exitCode : 1,
    });
  } else {
    process.stderr.write(`unlocalhost: ${errorMessage(error)}\n`);
  }
  process.exitCode = error instanceof UnlocalhostError ? error.exitCode : 1;
}
