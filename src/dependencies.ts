import { UnlocalhostError } from "./errors.js";
import { commandExists, runForeground } from "./process.js";

export type Dependency = "caddy" | "docker" | "cloudflared";
export type SetupDependency = Exclude<Dependency, "docker">;

interface DependencyRuntime {
  platform: NodeJS.Platform;
  commandExists(command: string): boolean;
  runForeground(command: string, args: string[]): Promise<number>;
}

export interface EnsureSetupDependencyOptions {
  interactive: boolean;
  confirmInstall?: (message: string) => Promise<boolean>;
  runtime?: DependencyRuntime;
}

export interface SetupDependencyResult {
  dependency: SetupDependency;
  installed: boolean;
}

interface DependencyHelpOptions {
  platform?: NodeJS.Platform;
  homebrewAvailable?: boolean;
}

const LINKS = {
  caddy: "https://caddyserver.com/docs/install",
  dockerMac: "https://docs.docker.com/desktop/setup/install/mac-install/",
  dockerLinux: "https://docs.docker.com/engine/install/",
  dockerWindows: "https://docs.docker.com/desktop/setup/install/windows-install/",
  cloudflared:
    "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/",
} as const;

export function dependencyHelp(
  dependency: Dependency,
  options: DependencyHelpOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const homebrewAvailable =
    options.homebrewAvailable ?? (platform === "darwin" && commandExists("brew"));
  if (dependency === "caddy") {
    if (platform === "darwin" && homebrewAvailable) {
      return `Caddy is required but was not found. Install it with: brew install caddy\nMore: ${LINKS.caddy}`;
    }
    return `Caddy is required but was not found. Installation instructions: ${LINKS.caddy}`;
  }

  if (dependency === "cloudflared") {
    if (platform === "darwin" && homebrewAvailable) {
      return `cloudflared is required for public tunnels but was not found. Install it with: brew install cloudflared\nMore: ${LINKS.cloudflared}`;
    }
    return `cloudflared is required for public tunnels but was not found. Installation instructions: ${LINKS.cloudflared}`;
  }

  if (platform === "darwin") {
    return `Docker with Compose was not found; it is required for Compose projects. Install and start Docker Desktop: ${LINKS.dockerMac}`;
  }
  if (platform === "win32") {
    return `Docker with Compose was not found; it is required for Compose projects. Install and start Docker Desktop: ${LINKS.dockerWindows}`;
  }
  return `Docker with Compose was not found; it is required for Compose projects. Installation instructions: ${LINKS.dockerLinux}`;
}

function dependencyLabel(dependency: SetupDependency): string {
  return dependency === "caddy" ? "Caddy" : "cloudflared";
}

function dependencyReason(dependency: SetupDependency): string {
  return dependency === "caddy"
    ? "routing and HTTPS"
    : "remote access with Cloudflare Tunnel";
}

export async function ensureSetupDependency(
  dependency: SetupDependency,
  options: EnsureSetupDependencyOptions,
): Promise<SetupDependencyResult> {
  const runtime = options.runtime ?? {
    platform: process.platform,
    commandExists,
    runForeground,
  };
  if (runtime.commandExists(dependency)) {
    return { dependency, installed: false };
  }

  const homebrewAvailable =
    runtime.platform === "darwin" && runtime.commandExists("brew");
  const help = () => dependencyHelp(dependency, {
    platform: runtime.platform,
    homebrewAvailable,
  });
  const canOfferHomebrew =
    options.interactive &&
    homebrewAvailable &&
    options.confirmInstall;
  if (!canOfferHomebrew) {
    throw new UnlocalhostError(help());
  }

  const label = dependencyLabel(dependency);
  const accepted = await options.confirmInstall!(
    `${label} is required for ${dependencyReason(dependency)} but was not found. Install it now with Homebrew?`,
  );
  if (!accepted) {
    throw new UnlocalhostError(help());
  }

  const code = await runtime.runForeground("brew", ["install", dependency]);
  if (code !== 0) {
    throw new UnlocalhostError(
      `Homebrew could not install ${label} (exit code ${code}).\n${help()}`,
    );
  }
  if (!runtime.commandExists(dependency)) {
    throw new UnlocalhostError(
      `${label} was installed but is not available on PATH.\n${help()}`,
    );
  }
  return { dependency, installed: true };
}
