export const STATUS_SCHEMA_VERSION = 1;

export interface GlobalConfig {
  default_projects_root: string;
  caddy_http_port: number;
  caddy_https_port: number;
  port_range_start: number;
  port_range_end: number;
  local_domain_suffix: string;
  public_domain: string;
  tunnel_enabled: boolean;
  tunnel_name: string;
  cloudflare_account_id: string;
  cloudflare_zone_id: string;
}

export interface EndpointConfig {
  id: string;
  slug: string;
  run_command?: string[];
  compose_service?: string;
  container_port?: number;
  upstream: {
    mode: "host_port";
    host: string;
    port: number;
  };
}

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  slug: string;
  enabled: boolean;
  compose_file?: string;
  compose_override?: string;
  compose_port_services?: string[];
  compose_service?: string;
  container_port?: number;
  run_command?: string[];
  endpoints: EndpointConfig[];
  upstream: {
    mode: "host_port";
    host: string;
    port: number;
  };
}

export interface EndpointStatus {
  id: string;
  slug: string;
  primary: boolean;
  local_url: string;
  public_url: string | null;
  upstream: string;
  proxy_route: boolean;
  upstream_health: {
    reachable: boolean;
    status: number | null;
    error: string | null;
  };
  process: {
    configured: boolean;
    running: boolean;
    pid: number | null;
    command: string[] | null;
    stdout_log: string | null;
    stderr_log: string | null;
  };
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ProjectStatus {
  id: string;
  name: string;
  path: string;
  local_url: string;
  public_url: string | null;
  upstream: string;
  enabled: boolean;
  compose: {
    configured: boolean;
    running: boolean | null;
    services: string[];
    error: string | null;
  };
  proxy_route: boolean;
  upstream_health: {
    reachable: boolean;
    status: number | null;
    error: string | null;
  };
  endpoints: EndpointStatus[];
}
