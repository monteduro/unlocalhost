import crypto from "node:crypto";
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
  return publicHostnameForSlug(project.slug, config);
}

function suffixedPublicSlug(slug: string, machine: string, separator: "-" | "--"): string {
  const suffix = `${separator}${machine}`;
  const available = 63 - suffix.length;
  if (available < 8) {
    throw new UnlocalhostError("machine alias is too long to build a public hostname");
  }
  if (slug.length <= available) return `${slug}${suffix}`;
  const digest = crypto.createHash("sha256").update(slug).digest("hex").slice(0, 6);
  const prefix = slug
    .slice(0, available - digest.length - 1)
    .replace(/-+$/g, "");
  return `${prefix}-${digest}${suffix}`;
}

export function machinePublicSlug(slug: string, machineAlias: string): string {
  return suffixedPublicSlug(slug, machineAlias, "-");
}

export function publicHostnameForSlug(
  slug: string,
  config: GlobalConfig,
): string | null {
  if (!config.public_domain) return null;
  const label =
    config.dns_mode === "project" && config.machine_alias
      ? machinePublicSlug(slug, config.machine_alias)
      : config.dns_mode === "project" && config.machine_id
        ? suffixedPublicSlug(slug, config.machine_id, "--")
      : slug;
  return `${label}.${config.public_domain}`;
}

export function localUrl(project: ProjectConfig, config: GlobalConfig): string {
  return `https://${localHostname(project, config)}${portSuffix(config.caddy_https_port, 443)}`;
}

export function publicUrl(project: ProjectConfig, config: GlobalConfig): string | null {
  if (project.public_enabled === false) return null;
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
  enabled = true,
): string | null {
  return enabled && config.public_domain
    ? `https://${publicHostnameForSlug(endpoint.slug, config)}`
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
  if (!endpoint.primary && endpoint.id === "vite") {
    return remote ? publicUrl(project, config) : localUrl(project, config);
  }
  return remote
    ? endpointPublicUrl(endpoint, config, project.public_enabled !== false)
    : endpointLocalUrl(endpoint, config);
}
