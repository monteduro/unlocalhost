import { getEndpoint } from "./endpoints.js";
import { UnlocalhostError } from "./errors.js";
import type { EndpointConfig, GlobalConfig, ProjectConfig } from "./types.js";

function portSuffix(port: number, standard: number): string {
  return port === standard ? "" : `:${port}`;
}

export function localHostname(project: ProjectConfig, config: GlobalConfig): string {
  return `${project.slug}.${config.local_domain_suffix}`;
}

export function publicHostname(project: ProjectConfig, config: GlobalConfig): string | null {
  return config.public_domain ? `${project.slug}.${config.public_domain}` : null;
}

export function localUrl(project: ProjectConfig, config: GlobalConfig): string {
  return `https://${localHostname(project, config)}${portSuffix(config.caddy_https_port, 443)}`;
}

export function publicUrl(project: ProjectConfig, config: GlobalConfig): string | null {
  const hostname = publicHostname(project, config);
  return hostname ? `https://${hostname}` : null;
}

export function endpointLocalUrl(
  endpoint: Pick<EndpointConfig, "slug">,
  config: GlobalConfig,
): string {
  return `https://${endpoint.slug}.${config.local_domain_suffix}${portSuffix(config.caddy_https_port, 443)}`;
}

export function endpointPublicUrl(
  endpoint: Pick<EndpointConfig, "slug">,
  config: GlobalConfig,
): string | null {
  return config.public_domain
    ? `https://${endpoint.slug}.${config.public_domain}`
    : null;
}

export function projectEndpointUrl(
  project: ProjectConfig,
  config: GlobalConfig,
  endpointId: string,
  remote = false,
): string | null {
  const endpoint = getEndpoint(project, endpointId);
  if (!endpoint) {
    throw new UnlocalhostError(
      `Endpoint "${endpointId}" is not registered in project "${project.id}"`,
    );
  }
  return remote
    ? endpointPublicUrl(endpoint, config)
    : endpointLocalUrl(endpoint, config);
}
