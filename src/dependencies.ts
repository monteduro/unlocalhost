export type Dependency = "caddy" | "docker" | "cloudflared";

const LINKS = {
  caddy: "https://caddyserver.com/docs/install",
  dockerMac: "https://docs.docker.com/desktop/setup/install/mac-install/",
  dockerLinux: "https://docs.docker.com/engine/install/",
  dockerWindows: "https://docs.docker.com/desktop/setup/install/windows-install/",
  cloudflared:
    "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/",
} as const;

export function dependencyHelp(dependency: Dependency): string {
  if (dependency === "caddy") {
    if (process.platform === "darwin") {
      return `Caddy is required but was not found. Install it with: brew install caddy\nMore: ${LINKS.caddy}`;
    }
    return `Caddy is required but was not found. Installation instructions: ${LINKS.caddy}`;
  }

  if (dependency === "cloudflared") {
    if (process.platform === "darwin") {
      return `cloudflared is required for public tunnels but was not found. Install it with: brew install cloudflared\nMore: ${LINKS.cloudflared}`;
    }
    return `cloudflared is required for public tunnels but was not found. Installation instructions: ${LINKS.cloudflared}`;
  }

  if (process.platform === "darwin") {
    return `Docker with Compose was not found; it is required for Compose projects. Install and start Docker Desktop: ${LINKS.dockerMac}`;
  }
  if (process.platform === "win32") {
    return `Docker with Compose was not found; it is required for Compose projects. Install and start Docker Desktop: ${LINKS.dockerWindows}`;
  }
  return `Docker with Compose was not found; it is required for Compose projects. Installation instructions: ${LINKS.dockerLinux}`;
}
