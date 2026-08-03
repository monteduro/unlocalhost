import { endpointRouteExists } from "./caddy.js";
import { composeStatus } from "./compose.js";
import { projectEndpoints, type ResolvedEndpoint } from "./endpoints.js";
import { errorMessage } from "./errors.js";
import { pathsFor } from "./paths.js";
import { listProjects } from "./registry.js";
import { endpointRunnerStatus } from "./runner.js";
import { serviceInstalled, serviceRunning } from "./services.js";
import { readTunnelId } from "./tunnel.js";
import { localUrl, projectEndpointUrl, publicUrl } from "./urls.js";
import { exists } from "./files.js";
import type {
  EndpointStatus,
  GlobalConfig,
  ProjectConfig,
  ProjectStatus,
} from "./types.js";
import { STATUS_SCHEMA_VERSION } from "./types.js";

async function upstreamHealth(
  endpoint: ResolvedEndpoint,
): Promise<ProjectStatus["upstream_health"]> {
  try {
    const response = await fetch(`http://${endpoint.upstream.host}:${endpoint.upstream.port}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(1500),
    });
    return { reachable: true, status: response.status, error: null };
  } catch (error) {
    return { reachable: false, status: null, error: errorMessage(error) };
  }
}

async function endpointStatus(
  home: string,
  config: GlobalConfig,
  project: ProjectConfig,
  endpoint: ResolvedEndpoint,
): Promise<EndpointStatus> {
  const [proxyRoute, health, processStatus] = await Promise.all([
    endpointRouteExists(home, project.id, endpoint.id),
    upstreamHealth(endpoint),
    endpointRunnerStatus(home, project, endpoint),
  ]);
  return {
    id: endpoint.id,
    slug: endpoint.slug,
    primary: endpoint.primary,
    local_url: projectEndpointUrl(project, config, endpoint.id, false)!,
    public_url: projectEndpointUrl(project, config, endpoint.id, true),
    upstream: `${endpoint.upstream.host}:${endpoint.upstream.port}`,
    proxy_route: proxyRoute,
    upstream_health: health,
    process: processStatus,
  };
}

export async function projectStatus(
  home: string,
  config: GlobalConfig,
  project: ProjectConfig,
): Promise<ProjectStatus> {
  const [compose, endpoints] = await Promise.all([
    composeStatus(home, project),
    Promise.all(
      projectEndpoints(project).map(
        async (endpoint) => await endpointStatus(home, config, project, endpoint),
      ),
    ),
  ]);
  const primary = endpoints[0]!;
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    local_url: localUrl(project, config),
    public_url: publicUrl(project, config),
    upstream: `${project.upstream.host}:${project.upstream.port}`,
    enabled: project.enabled,
    compose: {
      configured: Boolean(project.compose_file),
      ...compose,
    },
    proxy_route: primary.proxy_route,
    upstream_health: primary.upstream_health,
    endpoints,
  };
}

export async function fullStatus(
  home: string,
  config: GlobalConfig,
  onlyId?: string,
): Promise<Record<string, unknown>> {
  const all = await listProjects(home);
  const selected = onlyId ? all.filter((project) => project.id === onlyId) : all;
  if (onlyId && selected.length === 0) {
    const { UnlocalhostError } = await import("./errors.js");
    throw new UnlocalhostError(`Project "${onlyId}" is not registered`);
  }
  const projects = await Promise.all(
    selected.map(async (project) => await projectStatus(home, config, project)),
  );
  const proxy = {
    configured: await exists(pathsFor(home).caddyfile),
    installed: await serviceInstalled(home, "proxy"),
    running: await serviceRunning(home, "proxy"),
  };
  let tunnelId: string | null = null;
  try {
    tunnelId = await readTunnelId(home);
  } catch {
    // An uninitialized optional tunnel is a normal state.
  }
  const tunnel = {
    enabled: config.tunnel_enabled,
    configured: tunnelId !== null,
    installed: tunnelId ? await serviceInstalled(home, "tunnel", tunnelId) : false,
    running: tunnelId ? await serviceRunning(home, "tunnel", tunnelId) : false,
    id: tunnelId,
    dns_mode: config.dns_mode,
    machine_id: config.machine_id || null,
    machine_alias: config.machine_alias || null,
    public_domain: config.public_domain || null,
    wildcard:
      config.dns_mode === "wildcard" && config.public_domain
        ? `*.${config.public_domain}`
        : null,
  };
  return {
    schema_version: STATUS_SCHEMA_VERSION,
    home,
    proxy,
    tunnel,
    projects,
  };
}
