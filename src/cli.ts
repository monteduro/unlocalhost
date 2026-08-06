#!/usr/bin/env node

import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  checkbox as promptCheckbox,
  input as promptInput,
  select as promptSelect,
} from "@inquirer/prompts";
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
  migrateToProjectDns,
  normalizeMachineAlias,
  saveGlobalConfig,
  serializeProject,
  suggestedMachineAlias,
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
  setEndpointDevMode,
  setProjectPublicEnabled,
} from "./registry.js";
import {
  readEndpointLogs,
  startProjectRunners,
  stopProjectRunners,
  syncLaravelViteHotFile,
} from "./runner.js";
import {
  installService,
  serviceAction,
  serviceInstalled,
  serviceRunning,
  uninstallService,
} from "./services.js";
import { fullStatus } from "./status.js";
import {
  automaticComposeCandidate,
  composeDevCandidate,
  defaultSetupFeatures,
  defaultSlug,
  detectProject,
  devServerInstructions,
  hostDevDependenciesAvailable,
  managedDevCommand,
  managedStaticCommand,
  parseSetupFeatures,
  rankedHttpCandidates,
  type ProjectDetection,
  type SetupFeature,
} from "./setup.js";
import {
  ensureDnsRoutes,
  initializeTunnel,
  projectPublicHostnames,
  readTunnelId,
} from "./tunnel.js";
import {
  localUrl,
  publicHostnameForSlug,
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

async function configuredTunnelId(home: string): Promise<string | null> {
  try {
    return await readTunnelId(home);
  } catch {
    return null;
  }
}

async function ensureProjectDns(
  home: string,
  config: GlobalConfig,
  projects: ProjectConfig[],
) {
  if (!config.tunnel_enabled || config.dns_mode !== "project") return [];
  const tunnelId = await configuredTunnelId(home);
  if (!tunnelId) return [];
  return await ensureDnsRoutes(
    config,
    tunnelId,
    projectPublicHostnames(config, projects),
  );
}

async function removeProjectDns(
  config: GlobalConfig,
  projects: ProjectConfig[],
) {
  if (config.dns_mode !== "project") return [];
  return projectPublicHostnames(config, projects).map((hostname) => ({
    hostname,
    status: "retained" as const,
  }));
}

async function selectProjects(
  home: string,
  id: string | undefined,
  all: boolean | undefined,
): Promise<ProjectConfig[]> {
  if (id && all) {
    throw new UnlocalhostError('Specify a project id or "--all", not both');
  }
  if (all) return await listProjects(home);
  if (id) return [await getProject(home, id)];
  const cwd = path.resolve(process.cwd());
  const matches = (await listProjects(home))
    .filter((project) => {
      const relative = path.relative(project.path, cwd);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    })
    .sort((left, right) => right.path.length - left.path.length);
  if (matches[0]) return [matches[0]];
  throw new UnlocalhostError(
    'Current directory is not a registered project; pass an id or use "--all"',
  );
}

async function waitForEndpointHealth(
  projects: ProjectConfig[],
  timeoutMs = 5_000,
): Promise<Map<string, boolean>> {
  const endpoints = projects.flatMap((project) =>
    projectEndpoints(project).map((endpoint) => ({ project, endpoint })),
  );
  const result = new Map<string, boolean>();
  const pending = new Set(endpoints.map(({ project, endpoint }) => `${project.id}/${endpoint.id}`));
  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0 && Date.now() < deadline) {
    await Promise.all(
      endpoints.map(async ({ project, endpoint }) => {
        const key = `${project.id}/${endpoint.id}`;
        if (!pending.has(key)) return;
        try {
          await fetch(`http://${endpoint.upstream.host}:${endpoint.upstream.port}`, {
            signal: AbortSignal.timeout(300),
          });
          result.set(key, true);
          pending.delete(key);
        } catch {
          // A process or container may still be starting.
        }
      }),
    );
    if (pending.size > 0) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  for (const key of pending) result.set(key, false);
  return result;
}

async function chooseSetupFeatures(
  detection: ProjectDetection,
  value: string | undefined,
  command: Command,
): Promise<SetupFeature[]> {
  if (value) return parseSetupFeatures(value);
  const defaults = defaultSetupFeatures(detection);
  if (
    globalOptions(command).yes ||
    wantsJson(command) ||
    !process.stdin.isTTY ||
    !process.stderr.isTTY
  ) {
    return defaults;
  }
  const options: Array<{ feature: SetupFeature; label: string }> = [
    { feature: "https", label: "Local domain + HTTPS (recommended)" },
    ...(detection.devCommand
      ? [{
          feature: "dev" as const,
          label: `Development server / HMR (detected: ${detection.devServer ?? "npm script"})`,
        }]
      : []),
    { feature: "remote", label: "Remote access with Cloudflare Tunnel" },
  ];
  process.stderr.write(
    `Project detected: ${[
      detection.composeFile ? "Docker Compose" : null,
      detection.devServer,
      detection.staticRoot && !detection.devCommand ? `static HTML (${path.relative(detection.path, detection.staticRoot) || "."})` : null,
    ].filter(Boolean).join(" · ") || "generic HTTP project"}\n`,
  );
  const selected = await promptCheckbox<SetupFeature>({
    message: "What do you want to enable?",
    required: true,
    choices: options.map((option) => ({
      name: option.label,
      value: option.feature,
      checked: defaults.includes(option.feature),
    })),
  });
  return parseSetupFeatures(selected.join(","));
}

async function chooseSetupComposeCandidate(
  candidates: ComposeCandidate[],
  selection: string | undefined,
  command: Command,
): Promise<ComposeCandidate> {
  if (selection) return selectComposeCandidates(candidates, selection)[0]!;
  const automatic = automaticComposeCandidate(candidates);
  if (automatic) return automatic;
  const likely = rankedHttpCandidates(candidates);
  if (likely.length === 0) {
    throw new UnlocalhostError(
      "No likely HTTP Compose service was found; pass --services <service>:<port>",
    );
  }
  if (
    globalOptions(command).yes ||
    wantsJson(command) ||
    !process.stdin.isTTY ||
    !process.stderr.isTTY
  ) {
    return likely[0]!;
  }
  return await promptSelect<ComposeCandidate>({
    message: "Which service serves the application?",
    choices: likely.map((candidate) => ({
      name: `${candidate.service}:${candidate.containerPort} (${candidate.source})`,
      value: candidate,
    })),
  });
}

async function promptForDomain(command: Command): Promise<string> {
  if (
    globalOptions(command).yes ||
    wantsJson(command) ||
    !process.stdin.isTTY ||
    !process.stderr.isTTY
  ) {
    throw new UnlocalhostError(
      "Remote access needs a public domain; rerun setup with --domain <domain>",
    );
  }
  const answer = await promptInput({
    message: "Public Cloudflare root domain",
    required: true,
    validate: (value) => value.trim() ? true : "A public domain is required",
  });
  return answer.trim().replace(/^\*\./, "");
}

async function promptForMachineAlias(command: Command): Promise<string> {
  if (
    globalOptions(command).yes ||
    wantsJson(command) ||
    !process.stdin.isTTY ||
    !process.stderr.isTTY
  ) {
    throw new UnlocalhostError(
      "Remote access needs a persistent machine alias; rerun setup with --machine <alias>",
    );
  }
  const fallback = suggestedMachineAlias();
  const answer = await promptInput({
    message: "Alias for this machine (must be unique on the domain)",
    default: fallback,
    validate: (value) => {
      try {
        normalizeMachineAlias(value.trim() || fallback);
        return true;
      } catch (error) {
        return errorMessage(error);
      }
    },
  });
  return normalizeMachineAlias(answer.trim() || fallback);
}

async function promptForRunCommand(
  command: Command,
  purpose: "application" | "development server",
): Promise<string[]> {
  if (
    globalOptions(command).yes ||
    wantsJson(command) ||
    !process.stdin.isTTY ||
    !process.stderr.isTTY
  ) {
    throw new UnlocalhostError(
      `No standard ${purpose} command was detected; rerun setup with --run <command...>`,
    );
  }
  process.stderr.write(
    `\nNo standard ${purpose} command was detected.\n` +
      "Enter the command you normally use. unlocalhost injects HOST and PORT; " +
      "use {host} or {port} only when the command needs explicit arguments.\n",
  );
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await prompt.question("Start command: ")).trim();
    if (!answer) throw new UnlocalhostError("A start command is required");
    return normalizeRunCommand([answer])!;
  } finally {
    prompt.close();
  }
}

const program = new Command();
program
  .name("unlocalhost")
  .description("Develop on your own machine from anywhere.")
  .version("0.1.0-alpha.3")
  .option("--home <path>", "state directory (default: UNLOCALHOST_HOME or ~/.unlocalhost)")
  .option("--json", "emit machine-readable JSON where supported")
  .option("--yes", "accept non-interactive defaults")
  .showHelpAfterError()
  .addHelpText(
    "after",
    `
Agent-ready workflow:
  unlocalhost --yes setup "$PWD" --features https,dev
  unlocalhost --yes setup "$PWD" --features https,dev,remote --domain <domain> --machine <alias>
  unlocalhost --json status <slug>
  unlocalhost url <slug> --public

Run "unlocalhost setup" without flags for the interactive wizard. It detects
Compose or a local package dev command, allocates every port, configures Caddy,
and optionally reuses this machine's tunnel and exact project DNS. Project files are never edited;
required application changes are printed as explicit follow-up actions.

The lower-level add, endpoint, proxy, and tunnel commands remain available for
advanced automation. See GUIDE.md for the full reference.`,
  );

program
  .command("setup")
  .description("configure the current project with a short goal-oriented wizard")
  .argument("[path]", "project directory", ".")
  .option("--slug <slug>", "hostname-safe project id; defaults to the directory name")
  .option(
    "--features <list>",
    "non-interactive features: https,dev,remote (comma-separated)",
  )
  .option("--services <selection>", "primary Compose HTTP service; service:port disambiguates")
  .option("--domain <domain>", "public Cloudflare domain when remote access is selected")
  .option("--machine <alias>", "persistent, domain-unique machine alias for public hostnames")
  .option("--name <name>", "display name")
  .option("--no-start", "configure without starting the project")
  .option("--run <command...>", "managed local command; place this option last")
  .addHelpText(
    "after",
    `
Interactive quick start:
  cd my-project
  unlocalhost setup

Agent/non-interactive examples:
  unlocalhost --yes setup . --features https,dev
  unlocalhost --yes setup . --features https,dev,remote --domain example.com --machine studio

The wizard uses a checkbox list for outcomes before asking any project-specific
question. Ports, loopback mappings, Caddy routes, process environment, machine
identity, tunnel, and exact project DNS are managed automatically. Project
source and configuration are never edited. Static public/index.html projects
use public/ as their document root; other unknown stacks ask for the start
command. When an application setting is required it prints a precise follow-up
action. A legacy devhost Caddy service is stopped and archived automatically so
it cannot share the proxy ports with unlocalhost. The first remote setup stores
one readable machine alias and reuses it for later projects.`,
  )
  .action(async (projectPath: string, options, command: Command) => {
    const home = homeFor(command);
    const detection = await detectProject(projectPath);
    const features = await chooseSetupFeatures(detection, options.features, command);
    const wantsDev = features.includes("dev");
    const wantsRemote = features.includes("remote");
    const wantsHttps = features.includes("https");
    const explicitRun = normalizeRunCommand(options.run);

    const initialized = await initializeHome(home);
    let config = initialized.config;
    const previousPublicHostnames = wantsRemote && !config.machine_alias
      ? projectPublicHostnames(config, await listProjects(home))
      : [];
    if (options.domain) {
      config = {
        ...config,
        public_domain: String(options.domain).replace(/^\*\./, ""),
      };
    }
    if (wantsRemote && !config.public_domain) {
      config = { ...config, public_domain: await promptForDomain(command) };
    }
    if (options.machine) {
      const requestedAlias = normalizeMachineAlias(String(options.machine));
      if (config.machine_alias && config.machine_alias !== requestedAlias) {
        throw new UnlocalhostError(
          `This machine is already named "${config.machine_alias}"; edit config.toml deliberately to rename it`,
        );
      }
      config = { ...config, machine_alias: requestedAlias };
    }
    if (wantsRemote && !config.machine_alias) {
      config = { ...config, machine_alias: await promptForMachineAlias(command) };
    }
    const routingMigration = wantsRemote
      ? migrateToProjectDns(config)
      : { config, migrated: false };
    config = routingMigration.config;
    config = { ...config, tunnel_enabled: wantsRemote || config.tunnel_enabled };
    await saveGlobalConfig(home, config);

    const slug = options.slug ?? defaultSlug(detection.path);
    const registered = await listProjects(home);
    const samePath = registered.find((project) => project.path === detection.path);
    const sameId = registered.find((project) => project.id === slug);
    if (samePath && sameId && samePath.id !== sameId.id) {
      throw new UnlocalhostError(
        `Project path is registered as "${samePath.id}", while slug "${slug}" belongs to another project`,
      );
    }
    if (sameId && sameId.path !== detection.path) {
      throw new UnlocalhostError(
        `Slug "${slug}" is already registered for ${sameId.path}; pass a different --slug`,
      );
    }

    let project = samePath ?? sameId ?? null;
    let discovery: Awaited<ReturnType<typeof discoverCompose>> | null = null;
    let primaryCandidate: ComposeCandidate | null = null;
    let devEndpointId = "web";
    const existingManagedProcess = project
      ? projectEndpoints(project).some((endpoint) => endpoint.run_command)
      : false;
    let requestedRun = explicitRun;
    if (
      !requestedRun &&
      !detection.devCommand &&
      !detection.staticRoot &&
      !existingManagedProcess &&
      ((!project && !detection.composeFile) || wantsDev)
    ) {
      requestedRun = await promptForRunCommand(
        command,
        detection.composeFile ? "development server" : "application",
      );
    }
    const managedCommand = requestedRun ?? managedDevCommand(detection) ?? managedStaticCommand(detection);

    if (!project) {
      if (detection.composeFile) {
        discovery = await discoverCompose(detection.path, detection.composeFile);
        primaryCandidate = await chooseSetupComposeCandidate(
          discovery.candidates,
          options.services,
          command,
        );
        project = await addProject(home, {
          path: detection.path,
          slug,
          name: options.name,
          compose: discovery.composeFile,
          composePortServices: discovery.publishedServices,
          service: primaryCandidate.service,
          containerPort: primaryCandidate.containerPort,
          public: wantsRemote,
          dev: wantsDev,
        });
      } else {
        if (!managedCommand) {
          throw new UnlocalhostError(
            "No Compose application or managed local command was found; select the development server or pass --run <command...>",
          );
        }
        project = await addProject(home, {
          path: detection.path,
          slug,
          name: options.name,
          run: managedCommand,
          public: wantsRemote,
        });
      }
    } else {
      project = await setProjectPublicEnabled(home, project.id, wantsRemote);
      if (!project.compose_file && managedCommand && !project.run_command) {
        await setEndpointCommand(home, project.id, "web", managedCommand);
        project = await getProject(home, project.id);
      }
    }

    if (wantsDev) {
      await setEndpointDevMode(home, project.id, "web", true);
      project = await getProject(home, project.id);
    }

    if (wantsDev && project.compose_file && detection.devServer === "vite") {
      discovery ??= await discoverCompose(detection.path, project.compose_file);
      primaryCandidate ??= discovery.candidates.find(
        (candidate) =>
          candidate.service === project!.compose_service &&
          candidate.containerPort === project!.container_port,
      ) ?? await chooseSetupComposeCandidate(discovery.candidates, options.services, command);
      const primaryIsDevServer =
        (primaryCandidate.containerPort >= 5100 && primaryCandidate.containerPort < 5300) ||
        /vite/i.test(primaryCandidate.service);
      if (primaryIsDevServer) {
        devEndpointId = "web";
      } else {
        const endpointId = "vite";
        const existingEndpoint = getEndpoint(project, endpointId);
        if (!existingEndpoint) {
          const useHostRunner =
            Boolean(managedCommand) &&
            (await hostDevDependenciesAvailable(detection)) &&
            Boolean(detection.packageManager && commandExists(detection.packageManager));
          const composeCandidate = useHostRunner
            ? null
            : composeDevCandidate(
                discovery.candidates,
                primaryCandidate,
                detection.devServer,
              );
          if (composeCandidate) {
            await addEndpoint(home, project.id, {
              id: endpointId,
              slug: composeEndpointSlug(project.slug, endpointId),
              service: composeCandidate.service,
              containerPort: composeCandidate.containerPort,
              dev: true,
            });
          } else if (managedCommand) {
            await addEndpoint(home, project.id, {
              id: endpointId,
              slug: composeEndpointSlug(project.slug, endpointId),
              run: managedCommand,
            });
          }
        } else {
          await setEndpointDevMode(home, project.id, endpointId, true);
        }
        devEndpointId = endpointId;
        project = await getProject(home, project.id);
      }
    }

    const caddy = await rebuildRoutes(home, config);
    if ((wantsHttps || wantsRemote) && !commandExists("caddy")) {
      throw new UnlocalhostError(dependencyHelp("caddy"));
    }
    if (wantsHttps || wantsRemote) {
      await validateCaddyfile(home);
      // Installation is idempotent and also retires a conflicting pre-rename
      // devhost proxy, even when the unlocalhost service already exists.
      await installService(home, "proxy");
    }

    let tunnelResult: Record<string, unknown> | null = null;
    if (wantsRemote) {
      if (!commandExists("cloudflared")) {
        throw new UnlocalhostError(dependencyHelp("cloudflared"));
      }
      const publicProjects = await listProjects(home);
      const hostnames = projectPublicHostnames(config, publicProjects);
      let initializedTunnel: Awaited<ReturnType<typeof initializeTunnel>>;
      try {
        initializedTunnel = await initializeTunnel(home, config, hostnames);
      } catch (error) {
        const needsLogin = /login|authenticate|cert\.pem|origin certificate/i.test(
          errorMessage(error),
        );
        if (!needsLogin || !process.stdin.isTTY || wantsJson(command)) throw error;
        process.stderr.write(
          "\nCloudflare authentication is required. Opening the login flow...\n",
        );
        const loginCode = await runForeground("cloudflared", ["tunnel", "login"]);
        if (loginCode !== 0) throw error;
        initializedTunnel = await initializeTunnel(home, config, hostnames);
      }
      // Reinstalling is intentional: a wildcard-to-machine migration changes
      // the tunnel id stored in the supervised service definition.
      await installService(home, "tunnel", initializedTunnel.tunnel.id);
      tunnelResult = {
        ...initializedTunnel,
        tunnel_id: initializedTunnel.tunnel.id,
        running: true,
        machine_id: config.machine_id,
        machine_alias: config.machine_alias,
        migrated_from_wildcard: routingMigration.migrated,
      };
    }

    const lifecycle: Record<string, unknown> = {};
    if (options.start !== false) {
      if (project.compose_file) {
        await runCompose(home, project, "up");
        lifecycle.compose = "started";
      }
      if (projectEndpoints(project).some((endpoint) => endpoint.run_command)) {
        lifecycle.processes = await startProjectRunners(home, config, project);
      }
    }

    const health =
      options.start === false
        ? new Map<string, boolean>()
        : await waitForEndpointHealth([project]);
    if (
      options.start !== false &&
      wantsDev &&
      detection.framework === "laravel" &&
      detection.devServer === "vite"
    ) {
      const viteEndpoint = getEndpoint(project, devEndpointId);
      if (viteEndpoint && health.get(`${project.id}/${devEndpointId}`) !== false) {
        await syncLaravelViteHotFile(
          project,
          viteEndpoint,
          projectEndpointUrl(project, config, devEndpointId, wantsRemote)!,
          true,
        );
      }
    }
    const instructions = wantsDev
      ? devServerInstructions(detection, {
          localUrl: projectEndpointUrl(project, config, devEndpointId, false)!,
          publicUrl: projectEndpointUrl(project, config, devEndpointId, true),
          appLocalUrl: projectEndpointUrl(project, config, "web", false)!,
          appPublicUrl: projectEndpointUrl(project, config, "web", true),
        })
      : [];
    if (routingMigration.migrated) {
      instructions.push({
        level: "info",
        title: "Public routing migrated to this machine",
        lines: [
          `Machine id: ${config.machine_id}`,
          `Machine alias: ${config.machine_alias}`,
          "Existing wildcard DNS and legacy tunnels were left untouched so another machine is not disrupted.",
        ],
      });
    }
    const currentPublicHostnames = projectPublicHostnames(
      config,
      await listProjects(home),
    );
    const obsoletePublicHostnames = previousPublicHostnames.filter(
      (hostname) => !currentPublicHostnames.includes(hostname),
    );
    if (obsoletePublicHostnames.length > 0) {
      instructions.push({
        level: "action",
        title: "Remove previous machine hostnames from Cloudflare DNS",
        lines: obsoletePublicHostnames.map((hostname) => `Delete CNAME: ${hostname}`),
      });
    }
    if (options.start !== false) {
      for (const endpoint of projectEndpoints(project)) {
        if (health.get(`${project.id}/${endpoint.id}`) !== false) continue;
        if (endpoint.run_command) {
          instructions.push({
            level: "action",
            title: `${endpoint.id} did not bind its managed endpoint`,
            lines: [
              "Make the command honor HOST plus PORT (or VITE_PORT); never hardcode the allocated port.",
              `Inspect: unlocalhost logs ${project.id} --endpoint ${endpoint.id} --stderr`,
            ],
          });
        } else if (endpoint.id === devEndpointId && endpoint.compose_service) {
          const detectedCommand = detection.devCommand?.join(" ") ?? "the project's normal dev command";
          instructions.push({
            level: "action",
            title: `${endpoint.id} is mapped but not running inside Compose`,
            lines: [
              `Start ${detectedCommand} exactly once in service ${endpoint.compose_service}.`,
              `Then verify: unlocalhost --json status ${project.id}`,
            ],
          });
        } else {
          instructions.push({
            level: "info",
            title: `${endpoint.id} is not responding yet`,
            lines: [`Check again with: unlocalhost status ${project.id}`],
          });
        }
      }
    }
    if (wantsHttps && process.stdin.isTTY && !wantsJson(command)) {
      process.stderr.write("\nTrusting the local Caddy certificate authority (your OS may ask for a password)...\n");
      const trustCode = await runForeground("caddy", ["trust"]);
      if (trustCode !== 0) {
        instructions.push({
          level: "action",
          title: "Trust local HTTPS",
          lines: ["Run: caddy trust"],
        });
      }
    } else if (wantsHttps) {
      instructions.push({
        level: "info",
        title: "Local HTTPS trust",
        lines: ['Run "caddy trust" once on this machine if the certificate is not trusted yet.'],
      });
    }

    const endpoints = projectEndpoints(project).map((endpoint) => ({
      id: endpoint.id,
      local_url: projectEndpointUrl(project!, config, endpoint.id, false),
      public_url: projectEndpointUrl(project!, config, endpoint.id, true),
      managed_process: Boolean(endpoint.run_command),
      compose_service: endpoint.compose_service ?? null,
      reachable: health.get(`${project!.id}/${endpoint.id}`) ?? null,
    }));
    const human = [
      `\nReady: ${project.id}`,
      ...endpoints.flatMap((endpoint) => [
        `  ${endpoint.id}: ${endpoint.public_url ?? endpoint.local_url}`,
        ...(endpoint.public_url ? [`       local: ${endpoint.local_url}`] : []),
      ]),
      ...instructions.flatMap((instruction) => [
        "",
        `${instruction.level === "action" ? "ACTION" : "NOTE"}: ${instruction.title}`,
        ...instruction.lines.map((line) => `  ${line}`),
      ]),
      "",
      "Next time, from this project: unlocalhost up",
    ].join("\n");
    emit(command, human, {
      schema_version: 1,
      ok: true,
      home,
      detection,
      features,
      project,
      endpoints,
      instructions,
      lifecycle,
      caddy,
      tunnel: tunnelResult,
    });
  });

program
  .command("init")
  .description("create the external unlocalhost state directory")
  .option("--projects-root <path>", "default project discovery hint")
  .option("--domain <domain>", "public Cloudflare domain")
  .option("--machine <alias>", "persistent, domain-unique public machine alias")
  .option("--account-id <id>", "Cloudflare account id")
  .option("--zone-id <id>", "Cloudflare zone id")
  .option("--http-port <port>", "Caddy loopback HTTP port", parsePort)
  .option("--https-port <port>", "Caddy local HTTPS port", parsePort)
  .action(async (options, command: Command) => {
    const home = homeFor(command);
    const overrides: Partial<GlobalConfig> = {};
    if (options.projectsRoot) overrides.default_projects_root = options.projectsRoot;
    if (options.domain) overrides.public_domain = String(options.domain).replace(/^\*\./, "");
    if (options.machine) overrides.machine_alias = normalizeMachineAlias(String(options.machine));
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
  .option("--dev", "bypass shared caches on this endpoint's public tunnel route")
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
        dev: options.dev,
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
            dev: options.dev,
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
        dev: options.dev,
      });
    }
    const caddy = await rebuildRoutes(home, config);
    const dns = await ensureProjectDns(home, config, [project]);
    const registeredEndpoints = projectEndpoints(project).map((endpoint) => ({
      id: endpoint.id,
      service: endpoint.compose_service ?? null,
      container_port: endpoint.container_port ?? null,
      host_port: endpoint.upstream.port,
      local_url: projectEndpointUrl(project, config, endpoint.id, false),
      public_url: projectEndpointUrl(project, config, endpoint.id, true),
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
      dns,
      caddy,
    });
  });

program
  .command("rm")
  .alias("remove")
  .description("stop and remove a registration plus its generated external override")
  .argument("<id>")
  .option("--keep-running", "remove registration without stopping Compose")
  .action(async (id: string, options, command: Command) => {
    const home = homeFor(command);
    const config = await loadGlobalConfig(home);
    const registered = await getProject(home, id);
    await stopProjectRunners(home, registered);
    if (registered.compose_file && !options.keepRunning) {
      await runCompose(home, registered, "down");
    }
    const dns = await removeProjectDns(config, [registered]);
    const project = await removeProject(home, id);
    const caddy = await rebuildRoutes(home, config);
    const human = [
      `Removed ${project.id}`,
      ...(dns.length > 0
        ? [
            "ACTION: delete these DNS records manually from the Cloudflare dashboard:",
            ...dns.map((route) => `  ${route.hostname}`),
            "They no longer have a Caddy route and currently return 404.",
          ]
        : []),
    ].join("\n");
    emit(command, human, { ok: true, removed: project.id, dns, caddy });
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
          local_url: projectEndpointUrl(project, config, endpoint.id, false),
          public_url: projectEndpointUrl(project, config, endpoint.id, true),
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
  .option("--dev", "bypass shared caches on this endpoint's public tunnel route")
  .addHelpText(
    "after",
    `
Examples:
  # Vite runs inside a Compose service; every container may keep port 5173.
  unlocalhost endpoint add my-app vite --service web --container-port 5173

  # Vite runs directly on the host; unlocalhost allocates the listening port.
  unlocalhost endpoint add my-app vite
  unlocalhost port my-app --endpoint vite

The Vite upstream shares the application's browser hostname. Caddy dispatches
asset paths and HMR internally, so no second public DNS record or cross-origin
CORS configuration is needed. Laravel projects detected by setup receive an
external generated Vite wrapper automatically; other Vite projects receive the
exact origin/HMR action to apply.

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
      dev: options.dev,
    });
    const registered = await getProject(home, projectId);
    const caddy = await rebuildRoutes(home, config);
    const dns = await ensureProjectDns(home, config, [registered]);
    emit(
      command,
      `Added ${projectId}/${added.id}: ${projectEndpointUrl(registered, config, added.id, false)}`,
      {
        ok: true,
        project: projectId,
        endpoint: added,
        urls: {
          local: projectEndpointUrl(registered, config, added.id, false),
          public: projectEndpointUrl(registered, config, added.id, true),
        },
        dns,
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
      const caddy = await rebuildRoutes(home, await loadGlobalConfig(home));
      emit(command, `Saved command for ${projectId}/${name}: ${normalized.join(" ")}`, {
        ok: true,
        project: projectId,
        endpoint: name,
        command: normalized,
        caddy,
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
    const project = await getProject(home, projectId);
    const endpointToRemove = getEndpoint(project, name);
    const hostname = endpointToRemove && endpointToRemove.id !== "vite"
      ? publicHostnameForSlug(endpointToRemove.slug, config)
      : null;
    const dns =
      hostname && config.dns_mode === "project"
        ? [{ hostname, status: "retained" as const }]
        : [];
    const removed = await removeEndpoint(home, projectId, name);
    const caddy = await rebuildRoutes(home, config);
    emit(command, [
      `Removed ${projectId}/${removed.id}`,
      ...(dns.length > 0
        ? [
            "ACTION: delete this DNS record manually from the Cloudflare dashboard:",
            `  ${dns[0]!.hostname}`,
            "It no longer has a Caddy route and currently returns 404.",
          ]
        : []),
    ].join("\n"), {
      ok: true,
      project: projectId,
      removed: removed.id,
      dns,
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
      local_url: projectEndpointUrl(project, config, item.id, false),
      public_url: projectEndpointUrl(project, config, item.id, true),
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
      const hasRunners = projectEndpoints(project).some(
        (endpoint) => endpoint.run_command,
      );
      const managers: string[] = [];
      let processes: unknown[] = [];
      if (operation === "up") {
        if (project.compose_file) {
          await runCompose(home, project, "up");
          managers.push("compose");
        }
        if (hasRunners) {
          processes = await startProjectRunners(home, config, project);
          managers.push("runner");
        }
      } else {
        if (hasRunners) {
          processes = await stopProjectRunners(home, project);
          managers.push("runner");
        }
        if (project.compose_file) {
          await runCompose(home, project, "down");
          managers.push("compose");
        }
      }
      return { project: project.id, managers, processes };
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
  .description("start this project's Compose stack and/or saved processes")
  .argument("[id]", "project id; inferred from the current directory when omitted")
  .option("--all", "start every registered project")
  .action(async (id: string | undefined, options, command: Command) => {
    await composeOperation("up", id, options, command);
  });

program
  .command("down")
  .description("stop this project's Compose stack and/or saved processes")
  .argument("[id]", "project id; inferred from the current directory when omitted")
  .option("--all", "stop every registered project")
  .action(async (id: string | undefined, options, command: Command) => {
    await composeOperation("down", id, options, command);
  });

program
  .command("restart")
  .description("restart saved processes or a registered Compose project")
  .argument("[id]", "project id; inferred from the current directory when omitted")
  .action(async (id: string | undefined, _options, command: Command) => {
    const home = homeFor(command);
    const config = await loadGlobalConfig(home);
    const [project] = await selectProjects(home, id, false);
    if (!project) throw new UnlocalhostError("No project is registered");
    process.stderr.write(`Restarting ${project.id}...\n`);
    if (project.compose_file) {
      await stopProjectRunners(home, project);
      await runCompose(home, project, "down");
      await runCompose(home, project, "up");
      if (projectEndpoints(project).some((endpoint) => endpoint.run_command)) {
        await startProjectRunners(home, config, project);
      }
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
  .description("install and start the user service, replacing a legacy devhost proxy")
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
  .description("print the machine-specific tunnel setup guide")
  .action((_options, command: Command) => {
    const home = homeFor(command);
    const guide = [
      "1. Put the domain on Cloudflare.",
      "2. Run: cloudflared tunnel login",
      "3. Run: unlocalhost tunnel init --domain <domain> --machine <alias>",
      "4. Run: unlocalhost tunnel install",
      "5. Run: unlocalhost proxy install",
      "6. Run once for local HTTPS trust: caddy trust",
      "7. Register projects with unlocalhost setup; their exact DNS records are automatic.",
      "",
      `Generated tunnel state, machine id, alias, and public_domain are stored under ${home}.`,
      "Public URLs use <slug>-<machine-alias>.<public_domain>, keeping multiple machines independent.",
      "Automation alternative: set CLOUDFLARE_API_TOKEN and pass --account-id plus --zone-id.",
      "The token needs Account: Cloudflare Tunnel and Zone: DNS Edit.",
      "Each public endpoint gets one proxied first-level CNAME to this machine's tunnel.",
      "Project removal prints every exact DNS record that must be deleted manually in Cloudflare; it never claims automatic DNS cleanup.",
    ].join("\n");
    if (wantsJson(command)) printJson({ home, guide: guide.split("\n") });
    else printLine(guide);
  });
tunnel
  .command("init")
  .description("create/reuse this machine's tunnel and ensure project DNS")
  .option("--domain <domain>", "public domain, without '*.'")
  .option("--machine <alias>", "persistent, domain-unique public machine alias")
  .option("--name <name>", "tunnel name")
  .option("--account-id <id>", "Cloudflare account id for API-token setup")
  .option("--zone-id <id>", "Cloudflare zone id for API-token setup")
  .action(async (options, command: Command) => {
    const home = homeFor(command);
    const current = await loadGlobalConfig(home);
    const requestedAlias = options.machine
      ? normalizeMachineAlias(String(options.machine))
      : current.machine_alias || await promptForMachineAlias(command);
    if (current.machine_alias && current.machine_alias !== requestedAlias) {
      throw new UnlocalhostError(
        `This machine is already named "${current.machine_alias}"; edit config.toml deliberately to rename it`,
      );
    }
    const requested: GlobalConfig = {
      ...current,
      ...(options.domain ? { public_domain: String(options.domain).replace(/^\*\./, "") } : {}),
      ...(options.accountId ? { cloudflare_account_id: options.accountId } : {}),
      ...(options.zoneId ? { cloudflare_zone_id: options.zoneId } : {}),
      machine_alias: requestedAlias,
      tunnel_enabled: true,
    };
    const migration = migrateToProjectDns(requested);
    const next: GlobalConfig = {
      ...migration.config,
      ...(options.name ? { tunnel_name: options.name } : {}),
    };
    const projects = await listProjects(home);
    const hostnames = projectPublicHostnames(next, projects);
    const result = await initializeTunnel(home, next, hostnames);
    await saveGlobalConfig(home, next);
    await rebuildRoutes(home, next);
    emit(
      command,
      `Tunnel ${result.tunnel.name} ready for ${result.dns.length} public endpoint(s)`,
      {
        ok: true,
        ...result,
        machine_id: next.machine_id,
        machine_alias: next.machine_alias,
        public_domain: next.public_domain,
        migrated_from_wildcard: migration.migrated,
      },
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
