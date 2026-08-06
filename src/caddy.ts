import fs from "node:fs/promises";
import { dependencyHelp } from "./dependencies.js";
import { UnlocalhostError } from "./errors.js";
import { projectEndpoints, type ResolvedEndpoint } from "./endpoints.js";
import { exists, writeAtomic } from "./files.js";
import { pathsFor } from "./paths.js";
import { commandExists, runCommand } from "./process.js";
import { listProjects } from "./registry.js";
import { endpointLocalUrl, endpointPublicUrl, localUrl, publicUrl } from "./urls.js";
import type { GlobalConfig, ProjectConfig } from "./types.js";

function routeMarker(project: ProjectConfig, endpoint: ResolvedEndpoint): string {
  return endpoint.primary
    ? `unlocalhost-project:${project.id}`
    : `unlocalhost-project:${project.id}:endpoint:${endpoint.id}`;
}

function hostnameFromUrl(url: string): string {
  return new URL(url).hostname;
}

function viteProjectPathPattern(projectPath: string): string {
  const normalized = projectPath.replaceAll("\\", "/").replace(/\/+$/u, "");
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return JSON.stringify(`${absolute}/*`);
}

function reverseProxyLines(
  endpoint: ResolvedEndpoint,
  indent: string,
  forwardedProto?: "https",
  publicRoute = false,
  originOverride?: string,
): string[] {
  const options = [
    ...(forwardedProto
      ? [
          `${indent}\theader_up X-Forwarded-Proto ${forwardedProto}`,
          `${indent}\theader_up X-Forwarded-Port 443`,
        ]
      : []),
    ...(originOverride ? [`${indent}\theader_up Origin ${originOverride}`] : []),
    ...(endpoint.id === "vite" || endpoint.dev_server === "vite"
      ? [`${indent}\theader_up Host ${endpoint.upstream.host}:${endpoint.upstream.port}`]
      : []),
    ...(publicRoute && (endpoint.dev_mode || endpoint.run_command)
      ? [
          `${indent}\theader_down Cache-Control "private, no-cache, must-revalidate, max-age=0"`,
          `${indent}\theader_down Pragma "no-cache"`,
          `${indent}\theader_down Expires "0"`,
          `${indent}\theader_down Surrogate-Control "no-store"`,
          `${indent}\theader_down CDN-Cache-Control "no-store"`,
          `${indent}\theader_down Cloudflare-CDN-Cache-Control "no-store"`,
        ]
      : []),
  ];
  return options.length > 0
    ? [
        `${indent}reverse_proxy ${endpoint.upstream.host}:${endpoint.upstream.port} {`,
        ...options,
        `${indent}}`,
      ]
    : [`${indent}reverse_proxy ${endpoint.upstream.host}:${endpoint.upstream.port}`];
}

function routeBlock(
  addresses: string[],
  project: ProjectConfig,
  endpoint: ResolvedEndpoint,
  tlsInternal: boolean,
  forwardedProto?: "https",
  corsOrigin?: string,
  multiplexedVite?: ResolvedEndpoint,
  publicRoute = false,
  publicOrigin?: string,
): string {
  // Next.js 16 rejects its dev-only assets and HMR socket when their Origin is
  // a remote hostname. Normalize only same-origin Next internals, so unrelated
  // app requests keep their real Origin and cross-origin requests stay blocked.
  const rewriteNextDevOrigin = Boolean(
    publicRoute &&
      publicOrigin &&
      (endpoint.dev_server === "next" ||
        (endpoint.dev_server === undefined && (endpoint.dev_mode || endpoint.run_command))),
  );
  const nextDevOriginRoute = rewriteNextDevOrigin
    ? [
        "\t@unlocalhost_next_dev_same_origin {",
        "\t\tpath /_next/* /__nextjs*",
        `\t\theader Origin ${publicOrigin}`,
        "\t}",
        "\thandle @unlocalhost_next_dev_same_origin {",
        ...reverseProxyLines(endpoint, "\t\t", forwardedProto, publicRoute, "http://localhost"),
        "\t}",
      ]
    : [];
  const proxy = multiplexedVite
    ? [
        "\t@unlocalhost_vite_websocket {",
        "\t\theader Connection *Upgrade*",
        "\t\theader Upgrade websocket",
        "\t\tquery token=*",
        "\t}",
        "\thandle @unlocalhost_vite_websocket {",
        ...reverseProxyLines(multiplexedVite, "\t\t", forwardedProto, publicRoute),
        "\t}",
        `\t@unlocalhost_vite_assets path /@vite/* /@react-refresh /@id/* /@fs/* /node_modules/* /resources/* /src/* /__laravel_vite_plugin__/* ${viteProjectPathPattern(project.path)}`,
        "\thandle @unlocalhost_vite_assets {",
        ...reverseProxyLines(multiplexedVite, "\t\t", forwardedProto, publicRoute),
        "\t}",
        ...nextDevOriginRoute,
        "\thandle {",
        ...reverseProxyLines(endpoint, "\t\t", forwardedProto, publicRoute),
        "\t}",
      ]
    : rewriteNextDevOrigin
      ? [
          ...nextDevOriginRoute,
          "\thandle {",
          ...reverseProxyLines(endpoint, "\t\t", forwardedProto, publicRoute),
          "\t}",
        ]
      : reverseProxyLines(endpoint, "\t", forwardedProto, publicRoute);
  const lines = [
    `# ${routeMarker(project, endpoint)}`,
    `${addresses.join(", ")} {`,
    ...(tlsInternal ? ["\ttls internal"] : []),
    ...(corsOrigin
      ? [
          `\t@unlocalhost_cors header Origin ${corsOrigin}`,
          `\theader @unlocalhost_cors >Access-Control-Allow-Origin "${corsOrigin}"`,
          "\theader @unlocalhost_cors >Vary Origin",
        ]
      : []),
    ...proxy,
    "}",
  ];
  return lines.join("\n");
}

export function generateCaddyfile(config: GlobalConfig, projects: ProjectConfig[]): string {
  const enabled = projects.filter((project) => project.enabled);
  const blocks: string[] = [
    [
      "# Generated by unlocalhost. Project TOML files are the source of truth.",
      "{",
      "\tadmin 127.0.0.1:2019",
      `\thttp_port ${config.caddy_http_port}`,
      `\thttps_port ${config.caddy_https_port}`,
      "\tauto_https disable_redirects",
      "\tskip_install_trust",
      "}",
    ].join("\n"),
  ];
  for (const project of enabled) {
    const endpoints = projectEndpoints(project);
    const multiplexedVite = endpoints.find(
      (endpoint) => !endpoint.primary && endpoint.id === "vite",
    );
    for (const endpoint of endpoints) {
      const local = hostnameFromUrl(endpointLocalUrl(endpoint, config));
      const endpointRemoteUrl = endpointPublicUrl(
        endpoint,
        config,
        project.public_enabled !== false,
      );
      const viteLocalOrigin = endpoint.id === "vite" ? localUrl(project, config) : undefined;
      const vitePublicOrigin = endpoint.id === "vite" ? publicUrl(project, config) ?? undefined : undefined;
      blocks.push(
        routeBlock(
          [`http://${local}:${config.caddy_http_port}`],
          project,
          endpoint,
          false,
          undefined,
          viteLocalOrigin,
          endpoint.primary ? multiplexedVite : undefined,
        ),
        routeBlock(
          [`https://${local}:${config.caddy_https_port}`],
          project,
          endpoint,
          true,
          undefined,
          viteLocalOrigin,
          endpoint.primary ? multiplexedVite : undefined,
        ),
      );
      if (endpointRemoteUrl && endpoint !== multiplexedVite) {
        blocks.push(
          routeBlock(
            [`http://${hostnameFromUrl(endpointRemoteUrl)}:${config.caddy_http_port}`],
            project,
            endpoint,
            false,
            "https",
            vitePublicOrigin,
            endpoint.primary ? multiplexedVite : undefined,
            true,
            endpointRemoteUrl,
          ),
        );
      }
    }
  }
  if (enabled.length === 0) {
    blocks.push([
      `http://:${config.caddy_http_port}, https://:${config.caddy_https_port} {`,
      "\trespond \"No unlocalhost projects are registered\" 404",
      "}",
    ].join("\n"));
  }
  return `${blocks.join("\n\n")}\n`;
}

export async function rebuildCaddyfile(
  home: string,
  config: GlobalConfig,
): Promise<{ file: string; projectCount: number }> {
  const projects = await listProjects(home);
  const file = pathsFor(home).caddyfile;
  await writeAtomic(file, generateCaddyfile(config, projects));
  return { file, projectCount: projects.filter((project) => project.enabled).length };
}

export async function validateCaddyfile(home: string): Promise<void> {
  if (!commandExists("caddy")) {
    throw new UnlocalhostError(dependencyHelp("caddy"));
  }
  const result = await runCommand("caddy", [
    "validate",
    "--config",
    pathsFor(home).caddyfile,
    "--adapter",
    "caddyfile",
  ]);
  if (result.code !== 0) {
    throw new UnlocalhostError(`Caddy validation failed: ${result.stderr || result.stdout}`);
  }
}

export async function reloadCaddy(home: string): Promise<void> {
  await validateCaddyfile(home);
  const result = await runCommand("caddy", [
    "reload",
    "--config",
    pathsFor(home).caddyfile,
    "--adapter",
    "caddyfile",
  ]);
  if (result.code !== 0) {
    throw new UnlocalhostError(`Caddy reload failed: ${result.stderr || result.stdout}`);
  }
}

export async function maybeReloadCaddy(home: string): Promise<boolean> {
  if (!commandExists("caddy") || !(await exists(pathsFor(home).caddyfile))) return false;
  await validateCaddyfile(home);
  const result = await runCommand("caddy", [
    "reload",
    "--config",
    pathsFor(home).caddyfile,
    "--adapter",
    "caddyfile",
  ]);
  return result.code === 0;
}

export async function routeExists(home: string, id: string): Promise<boolean> {
  return await endpointRouteExists(home, id, "web");
}

export async function endpointRouteExists(
  home: string,
  projectId: string,
  endpointId: string,
): Promise<boolean> {
  const file = pathsFor(home).caddyfile;
  if (!(await exists(file))) return false;
  const marker =
    endpointId === "web"
      ? `# unlocalhost-project:${projectId}\n`
      : `# unlocalhost-project:${projectId}:endpoint:${endpointId}\n`;
  return (await fs.readFile(file, "utf8")).includes(marker);
}
