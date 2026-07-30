import os from "node:os";
import path from "node:path";

export interface UnlocalhostPaths {
  home: string;
  config: string;
  projects: string;
  overrides: string;
  caddy: string;
  caddyfile: string;
  cloudflared: string;
  cloudflaredConfig: string;
  logs: string;
  run: string;
}

export function expandTilde(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function resolveUnlocalhostHome(option?: string): string {
  const raw = option || process.env.UNLOCALHOST_HOME || path.join(os.homedir(), ".unlocalhost");
  return path.resolve(expandTilde(raw));
}

export function pathsFor(home: string): UnlocalhostPaths {
  return {
    home,
    config: path.join(home, "config.toml"),
    projects: path.join(home, "projects"),
    overrides: path.join(home, "overrides"),
    caddy: path.join(home, "caddy"),
    caddyfile: path.join(home, "caddy", "Caddyfile"),
    cloudflared: path.join(home, "cloudflared"),
    cloudflaredConfig: path.join(home, "cloudflared", "config.yml"),
    logs: path.join(home, "logs"),
    run: path.join(home, "run"),
  };
}
