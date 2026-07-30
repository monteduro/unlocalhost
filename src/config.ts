import fs from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import { UnlocalhostError } from "./errors.js";
import { ensureDir, exists, writeAtomic } from "./files.js";
import { pathsFor } from "./paths.js";
import type { EndpointConfig, GlobalConfig, ProjectConfig } from "./types.js";

export const DEFAULT_CONFIG: GlobalConfig = {
  default_projects_root: "~/Sites",
  caddy_http_port: 8080,
  caddy_https_port: 8443,
  port_range_start: 12000,
  port_range_end: 19999,
  local_domain_suffix: "localhost",
  public_domain: "",
  tunnel_enabled: false,
  tunnel_name: "unlocalhost",
  cloudflare_account_id: "",
  cloudflare_zone_id: "",
};

function requiredString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new UnlocalhostError(`Invalid ${name} in configuration`);
  }
  return value;
}

function validPort(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new UnlocalhostError(`Invalid ${name}: expected an integer from 1 to 65535`);
  }
  return Number(value);
}

function validHostname(value: unknown, name: string, allowEmpty = false): string {
  const hostname = requiredString(value, name, allowEmpty).toLowerCase().replace(/^\.+|\.+$/g, "");
  if (allowEmpty && hostname === "") return "";
  if (
    hostname.length > 253 ||
    !hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new UnlocalhostError(`Invalid ${name}: expected a DNS hostname`);
  }
  return hostname;
}

function validSlug(value: unknown, name: string): string {
  const slug = requiredString(value, name).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
    throw new UnlocalhostError(`Invalid ${name}: expected a hostname-safe slug`);
  }
  return slug;
}

function validCommand(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((part) => typeof part === "string" && part.length > 0)
  ) {
    throw new UnlocalhostError(`Invalid ${name}: expected a non-empty command array`);
  }
  return value as string[];
}

function validComposeServices(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    !value.every(
      (service) =>
        typeof service === "string" && /^[a-zA-Z0-9_.-]+$/.test(service),
    )
  ) {
    throw new UnlocalhostError(`Invalid ${name}: expected an array of Compose service names`);
  }
  return [...new Set(value as string[])];
}

export function parseGlobalConfig(source: string): GlobalConfig {
  let value: Record<string, unknown>;
  try {
    value = parse(source) as Record<string, unknown>;
  } catch (error) {
    throw new UnlocalhostError(`Cannot parse config.toml: ${String(error)}`);
  }
  const config: GlobalConfig = {
    default_projects_root: requiredString(
      value.default_projects_root ?? DEFAULT_CONFIG.default_projects_root,
      "default_projects_root",
    ),
    caddy_http_port: validPort(
      value.caddy_http_port ?? DEFAULT_CONFIG.caddy_http_port,
      "caddy_http_port",
    ),
    caddy_https_port: validPort(
      value.caddy_https_port ?? DEFAULT_CONFIG.caddy_https_port,
      "caddy_https_port",
    ),
    port_range_start: validPort(
      value.port_range_start ?? DEFAULT_CONFIG.port_range_start,
      "port_range_start",
    ),
    port_range_end: validPort(
      value.port_range_end ?? DEFAULT_CONFIG.port_range_end,
      "port_range_end",
    ),
    local_domain_suffix: validHostname(
      value.local_domain_suffix ?? DEFAULT_CONFIG.local_domain_suffix,
      "local_domain_suffix",
    ),
    public_domain: validHostname(
      value.public_domain ?? DEFAULT_CONFIG.public_domain,
      "public_domain",
      true,
    ),
    tunnel_enabled:
      typeof value.tunnel_enabled === "boolean"
        ? value.tunnel_enabled
        : DEFAULT_CONFIG.tunnel_enabled,
    tunnel_name: requiredString(
      value.tunnel_name ?? DEFAULT_CONFIG.tunnel_name,
      "tunnel_name",
    ),
    cloudflare_account_id: requiredString(
      value.cloudflare_account_id ?? DEFAULT_CONFIG.cloudflare_account_id,
      "cloudflare_account_id",
      true,
    ),
    cloudflare_zone_id: requiredString(
      value.cloudflare_zone_id ?? DEFAULT_CONFIG.cloudflare_zone_id,
      "cloudflare_zone_id",
      true,
    ),
  };
  if (config.port_range_start > config.port_range_end) {
    throw new UnlocalhostError("Invalid port range: port_range_start must not exceed port_range_end");
  }
  return config;
}

export function serializeGlobalConfig(config: GlobalConfig): string {
  return `# unlocalhost machine-level settings. Project registrations live in projects/.\n${stringify(config)}`;
}

export function parseProject(source: string, filename = "project"): ProjectConfig {
  let value: Record<string, unknown>;
  try {
    value = parse(source) as Record<string, unknown>;
  } catch (error) {
    throw new UnlocalhostError(`Cannot parse ${filename}: ${String(error)}`);
  }
  const upstream = value.upstream as Record<string, unknown> | undefined;
  if (!upstream || upstream.mode !== "host_port") {
    throw new UnlocalhostError(`${filename}: only upstream.mode = "host_port" is supported in v1`);
  }
  const rawEndpoints = value.endpoints;
  if (rawEndpoints !== undefined && !Array.isArray(rawEndpoints)) {
    throw new UnlocalhostError(`${filename}.endpoints: expected an array of endpoint tables`);
  }
  const endpoints: EndpointConfig[] = (rawEndpoints ?? []).map((raw, index) => {
    const endpoint = raw as Record<string, unknown>;
    const endpointUpstream = endpoint.upstream as Record<string, unknown> | undefined;
    if (!endpointUpstream || endpointUpstream.mode !== "host_port") {
      throw new UnlocalhostError(
        `${filename}.endpoints[${index}]: only upstream.mode = "host_port" is supported`,
      );
    }
    const parsed: EndpointConfig = {
      id: validSlug(endpoint.id, `${filename}.endpoints[${index}].id`),
      slug: validSlug(endpoint.slug, `${filename}.endpoints[${index}].slug`),
      upstream: {
        mode: "host_port",
        host: requiredString(
          endpointUpstream.host,
          `${filename}.endpoints[${index}].upstream.host`,
        ),
        port: validPort(
          endpointUpstream.port,
          `${filename}.endpoints[${index}].upstream.port`,
        ),
      },
    };
    const runCommand = validCommand(
      endpoint.run_command,
      `${filename}.endpoints[${index}].run_command`,
    );
    if (runCommand) parsed.run_command = runCommand;
    if (typeof endpoint.compose_service === "string" && endpoint.compose_service) {
      parsed.compose_service = endpoint.compose_service;
    }
    if (endpoint.container_port !== undefined) {
      parsed.container_port = validPort(
        endpoint.container_port,
        `${filename}.endpoints[${index}].container_port`,
      );
    }
    if (parsed.upstream.host !== "127.0.0.1" && parsed.upstream.host !== "localhost") {
      throw new UnlocalhostError(
        `${filename}.endpoints[${index}].upstream.host: v1 accepts only 127.0.0.1 or localhost`,
      );
    }
    return parsed;
  });
  const project: ProjectConfig = {
    id: validSlug(value.id, `${filename}.id`),
    name: requiredString(value.name, `${filename}.name`),
    path: path.resolve(requiredString(value.path, `${filename}.path`)),
    slug: validSlug(value.slug, `${filename}.slug`),
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    endpoints,
    upstream: {
      mode: "host_port",
      host: requiredString(upstream.host, `${filename}.upstream.host`),
      port: validPort(upstream.port, `${filename}.upstream.port`),
    },
  };
  if (project.upstream.host !== "127.0.0.1" && project.upstream.host !== "localhost") {
    throw new UnlocalhostError(
      `${filename}.upstream.host: v1 accepts only 127.0.0.1 or localhost`,
    );
  }
  const ids = new Set(["web"]);
  const slugs = new Set([project.slug]);
  const upstreams = new Set([`${project.upstream.host}:${project.upstream.port}`]);
  for (const endpoint of project.endpoints) {
    if (ids.has(endpoint.id)) {
      throw new UnlocalhostError(`${filename}: duplicate endpoint id "${endpoint.id}"`);
    }
    if (slugs.has(endpoint.slug)) {
      throw new UnlocalhostError(`${filename}: duplicate endpoint slug "${endpoint.slug}"`);
    }
    const address = `${endpoint.upstream.host}:${endpoint.upstream.port}`;
    if (upstreams.has(address)) {
      throw new UnlocalhostError(`${filename}: duplicate endpoint upstream "${address}"`);
    }
    ids.add(endpoint.id);
    slugs.add(endpoint.slug);
    upstreams.add(address);
  }
  if (typeof value.compose_file === "string" && value.compose_file) {
    project.compose_file = value.compose_file;
  }
  if (typeof value.compose_override === "string" && value.compose_override) {
    project.compose_override = value.compose_override;
  }
  const composePortServices = validComposeServices(
    value.compose_port_services,
    `${filename}.compose_port_services`,
  );
  if (composePortServices) project.compose_port_services = composePortServices;
  if (typeof value.compose_service === "string" && value.compose_service) {
    project.compose_service = value.compose_service;
  }
  if (value.container_port !== undefined) {
    project.container_port = validPort(value.container_port, `${filename}.container_port`);
  }
  const runCommand = validCommand(value.run_command, `${filename}.run_command`);
  if (runCommand) project.run_command = runCommand;
  if (Boolean(project.compose_service) !== Boolean(project.container_port)) {
    throw new UnlocalhostError(
      `${filename}: compose_service and container_port must be configured together`,
    );
  }
  for (const endpoint of project.endpoints) {
    if (Boolean(endpoint.compose_service) !== Boolean(endpoint.container_port)) {
      throw new UnlocalhostError(
        `${filename}: endpoint "${endpoint.id}" compose_service and container_port must be configured together`,
      );
    }
  }
  return project;
}

export function serializeProject(project: ProjectConfig): string {
  const top: Record<string, unknown> = {
    id: project.id,
    name: project.name,
    path: project.path,
    slug: project.slug,
    enabled: project.enabled,
  };
  if (project.compose_file) top.compose_file = project.compose_file;
  if (project.compose_override) top.compose_override = project.compose_override;
  if (project.compose_port_services !== undefined) {
    top.compose_port_services = project.compose_port_services;
  }
  if (project.compose_service) top.compose_service = project.compose_service;
  if (project.container_port) top.container_port = project.container_port;
  if (project.run_command) top.run_command = project.run_command;
  top.upstream = project.upstream;
  if (project.endpoints.length > 0) top.endpoints = project.endpoints;
  return `# Managed by unlocalhost. Safe to edit while unlocalhost is stopped.\n${stringify(top)}`;
}

export async function initializeHome(home: string, overrides: Partial<GlobalConfig> = {}): Promise<{
  created: boolean;
  config: GlobalConfig;
}> {
  const paths = pathsFor(home);
  await Promise.all([
    ensureDir(paths.home),
    ensureDir(paths.projects),
    ensureDir(paths.overrides),
    ensureDir(paths.caddy),
    ensureDir(paths.cloudflared),
    ensureDir(paths.logs),
    ensureDir(paths.run),
  ]);
  if (await exists(paths.config)) {
    return { created: false, config: await loadGlobalConfig(home) };
  }
  const config = { ...DEFAULT_CONFIG, ...overrides };
  await writeAtomic(paths.config, serializeGlobalConfig(config));
  return { created: true, config };
}

export async function loadGlobalConfig(home: string): Promise<GlobalConfig> {
  const file = pathsFor(home).config;
  if (!(await exists(file))) {
    throw new UnlocalhostError(`unlocalhost is not initialized at ${home}; run "unlocalhost init" first`);
  }
  return parseGlobalConfig(await fs.readFile(file, "utf8"));
}

export async function saveGlobalConfig(home: string, config: GlobalConfig): Promise<void> {
  await writeAtomic(pathsFor(home).config, serializeGlobalConfig(config));
}
