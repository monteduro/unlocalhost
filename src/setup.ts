import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { UnlocalhostError } from "./errors.js";
import { exists } from "./files.js";
import type { ComposeCandidate } from "./compose-discovery.js";
import type { DevServerKind } from "./types.js";

export type SetupFeature = "https" | "dev" | "remote";
export type { DevServerKind } from "./types.js";
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
export type FrameworkKind = "laravel";

export interface ProjectDetection {
  path: string;
  composeFile: string | null;
  packageFile: string | null;
  packageManager: PackageManager | null;
  framework: FrameworkKind | null;
  devScript: string | null;
  devServer: DevServerKind | null;
  devCommand: string[] | null;
  staticRoot: string | null;
}

export interface SetupInstruction {
  level: "info" | "action";
  title: string;
  lines: string[];
}

function detectDevServerKind(
  dependencies: Record<string, unknown>,
  devScript: string | null,
): DevServerKind | null {
  if ("next" in dependencies || /(?:^|\s)next(?:\s|$)/.test(devScript ?? "")) {
    return "next";
  }
  if ("vite" in dependencies || /(?:^|\s)vite(?:\s|$)/.test(devScript ?? "")) {
    return "vite";
  }
  if ("@angular/cli" in dependencies || /(?:^|\s)ng\s+serve(?:\s|$)/.test(devScript ?? "")) {
    return "angular";
  }
  if ("astro" in dependencies || /(?:^|\s)astro\s+dev(?:\s|$)/.test(devScript ?? "")) {
    return "astro";
  }
  return devScript ? "generic" : null;
}

const COMPOSE_FILES = [
  "compose.yml",
  "compose.yaml",
  "docker-compose.yml",
  "docker-compose.yaml",
] as const;

const NON_HTTP_SERVICE = /(?:^|[-_.])(db|database|mysql|mariadb|postgres|postgresql|redis|memcached|mongo|mongodb|mailpit|mailhog)(?:$|[-_.])/i;
const NON_HTTP_PORTS = new Set([3306, 5432, 6379, 11211, 27017, 1025]);

function packageManagerCommand(manager: PackageManager, script: string): string[] {
  if (manager === "yarn") return ["yarn", "run", script];
  return [manager, "run", script];
}

async function detectPackageManager(
  projectPath: string,
  packageManagerField: unknown,
): Promise<PackageManager> {
  if (typeof packageManagerField === "string") {
    const name = packageManagerField.split("@", 1)[0];
    if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") {
      return name;
    }
  }
  for (const [filename, manager] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ] as const) {
    if (await exists(path.join(projectPath, filename))) return manager;
  }
  return "npm";
}

export async function detectProject(projectPath: string): Promise<ProjectDetection> {
  const root = path.resolve(projectPath);
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new UnlocalhostError(`Project path does not exist or is not a directory: ${root}`);
  }
  const composeFile =
    (await Promise.all(
      COMPOSE_FILES.map(async (filename) => ((await exists(path.join(root, filename))) ? filename : null)),
    )).find((filename) => filename !== null) ?? null;
  const framework: FrameworkKind | null = await exists(path.join(root, "artisan"))
    ? "laravel"
    : null;
  const staticRoot = (await exists(path.join(root, "public", "index.html")))
    ? path.join(root, "public")
    : (await exists(path.join(root, "index.html")))
      ? root
      : null;
  const packageFile = path.join(root, "package.json");
  if (!(await exists(packageFile))) {
    return {
      path: root,
      composeFile,
      packageFile: null,
      packageManager: null,
      framework,
      devScript: null,
      devServer: null,
      devCommand: null,
      staticRoot,
    };
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await fs.readFile(packageFile, "utf8")) as Record<string, unknown>;
  } catch {
    throw new UnlocalhostError(`Cannot parse ${packageFile}`);
  }
  const scripts =
    manifest.scripts && typeof manifest.scripts === "object"
      ? (manifest.scripts as Record<string, unknown>)
      : {};
  const devScript = typeof scripts.dev === "string" ? scripts.dev : null;
  const dependencies = {
    ...(manifest.dependencies && typeof manifest.dependencies === "object"
      ? (manifest.dependencies as Record<string, unknown>)
      : {}),
    ...(manifest.devDependencies && typeof manifest.devDependencies === "object"
      ? (manifest.devDependencies as Record<string, unknown>)
      : {}),
  };
  const devServer = detectDevServerKind(dependencies, devScript);
  const packageManager = await detectPackageManager(root, manifest.packageManager);
  return {
    path: root,
    composeFile,
    packageFile,
    packageManager,
    framework,
    devScript,
    devServer,
    devCommand: devScript ? packageManagerCommand(packageManager, "dev") : null,
    staticRoot,
  };
}

export function defaultSetupFeatures(detection: ProjectDetection): SetupFeature[] {
  return detection.devCommand ? ["https", "dev"] : ["https"];
}

export function parseSetupFeatures(value: string): SetupFeature[] {
  const aliases: Record<string, SetupFeature> = {
    https: "https",
    local: "https",
    dev: "dev",
    vite: "dev",
    hmr: "dev",
    remote: "remote",
    tunnel: "remote",
  };
  const selected: SetupFeature[] = [];
  for (const token of value.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean)) {
    const feature = aliases[token];
    if (!feature) {
      throw new UnlocalhostError(
        `Unknown setup feature "${token}"; choose https, dev, and/or remote`,
      );
    }
    if (!selected.includes(feature)) selected.push(feature);
  }
  if (selected.length === 0) throw new UnlocalhostError("Select at least one setup feature");
  if (!selected.includes("https") && !selected.includes("remote")) {
    throw new UnlocalhostError("Select local HTTPS or remote access so the endpoint can be reached");
  }
  return selected;
}

export function defaultSlug(projectPath: string): string {
  const slug = path.basename(path.resolve(projectPath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  if (!slug) throw new UnlocalhostError("Cannot derive a project slug; pass --slug <name>");
  return slug;
}

function candidateScore(candidate: ComposeCandidate): number {
  if (NON_HTTP_SERVICE.test(candidate.service) || NON_HTTP_PORTS.has(candidate.containerPort)) {
    return -1000;
  }
  let score = 0;
  if (candidate.containerPort === 80) score += 100;
  else if (candidate.containerPort === 443) score += 90;
  else if ([3000, 4000, 5000, 8000, 8080, 8081, 8888].includes(candidate.containerPort)) score += 50;
  if (/(?:^|[-_.])(web|app|api|frontend|backend|server)(?:$|[-_.])/i.test(candidate.service)) score += 30;
  if (candidate.source === "ports") score += 5;
  return score;
}

export function rankedHttpCandidates(candidates: ComposeCandidate[]): ComposeCandidate[] {
  return candidates
    .filter((candidate) => candidateScore(candidate) > -1000)
    .sort((left, right) => candidateScore(right) - candidateScore(left));
}

export function automaticComposeCandidate(
  candidates: ComposeCandidate[],
): ComposeCandidate | null {
  const ranked = rankedHttpCandidates(candidates);
  if (ranked.length === 0) return null;
  if (ranked.length === 1) return ranked[0]!;
  return candidateScore(ranked[0]!) > candidateScore(ranked[1]!) ? ranked[0]! : null;
}

export function composeDevCandidate(
  candidates: ComposeCandidate[],
  primary: ComposeCandidate,
  kind: DevServerKind | null,
): ComposeCandidate | null {
  if (!kind) return null;
  const others = rankedHttpCandidates(candidates).filter(
    (candidate) =>
      !(candidate.service === primary.service && candidate.containerPort === primary.containerPort),
  );
  if (kind === "vite") {
    return (
      others.find(
        (candidate) =>
          candidate.service === primary.service && candidate.containerPort >= 5100 && candidate.containerPort < 5300,
      ) ??
      others.find((candidate) => /vite/i.test(candidate.service)) ??
      null
    );
  }
  return null;
}

export function managedDevCommand(detection: ProjectDetection): string[] | null {
  if (!detection.devCommand) return null;
  if (detection.devServer === "angular" || detection.devServer === "astro") {
    return [
      ...detection.devCommand,
      "--",
      "--host",
      "{host}",
      "--port",
      "{port}",
    ];
  }
  if (detection.devServer !== "vite") return detection.devCommand;
  return [
    ...detection.devCommand,
    "--",
    "--host",
    "{host}",
    "--port",
    "{port}",
    "--strictPort",
  ];
}

export function managedStaticCommand(detection: ProjectDetection): string[] | null {
  if (!detection.staticRoot || detection.composeFile || detection.devCommand) return null;
  const currentFile = fileURLToPath(import.meta.url);
  const entry = currentFile.endsWith(".ts")
    ? path.resolve(path.dirname(currentFile), "../dist/static-server.js")
    : path.join(path.dirname(currentFile), "static-server.js");
  return [
    process.execPath,
    entry,
    "--root",
    detection.staticRoot,
    "--host",
    "{host}",
    "--port",
    "{port}",
  ];
}

export async function hostDevDependenciesAvailable(
  detection: ProjectDetection,
): Promise<boolean> {
  if (!detection.packageManager || !detection.devCommand) return false;
  if (
    detection.devServer === "vite" ||
    detection.devServer === "next" ||
    detection.devServer === "angular" ||
    detection.devServer === "astro"
  ) {
    const binary = detection.devServer === "angular" ? "ng" : detection.devServer;
    return await exists(
      path.join(
        detection.path,
        "node_modules",
        ".bin",
        process.platform === "win32" ? `${binary}.cmd` : binary,
      ),
    );
  }
  return await exists(path.join(detection.path, "node_modules"));
}

export function devServerInstructions(
  detection: ProjectDetection,
  values: {
    localUrl: string;
    publicUrl: string | null;
    appLocalUrl?: string;
    appPublicUrl?: string | null;
  },
): SetupInstruction[] {
  if (detection.devServer === "vite") {
    const endpointUrls = [values.localUrl, values.publicUrl].filter(
      (value): value is string => Boolean(value),
    );
    if (detection.framework === "laravel") {
      return [
        {
          level: "info",
          title: "Laravel Vite endpoint configured",
          lines: [
            `Endpoint: ${values.publicUrl ?? values.localUrl}`,
            "unlocalhost wraps the existing Vite config from external state, keeps Laravel's ephemeral public/hot URL aligned after restarts, and serves assets and HMR through the application hostname.",
            "No Vite port, origin, allowedHosts, or HMR hostname needs to be hardcoded in the project.",
          ],
        },
      ];
    }
    return [
      {
        level: "info",
        title: "Vite development endpoint configured",
        lines: [
          `Endpoint: ${values.publicUrl ?? values.localUrl}`,
          `Allowed endpoint hosts: ${endpointUrls.map((value) => new URL(value).hostname).join(", ")}.`,
          "unlocalhost adapts the upstream Host and proxies assets and HMR through the application origin.",
          "No server.allowedHosts, server.origin, HMR hostname, or Caddy setting needs to be hardcoded in the project.",
        ],
      },
    ];
  }
  if (detection.devServer === "next") {
    return [
      {
        level: "info",
        title: "Next.js development endpoint configured",
        lines: [
          `Endpoint: ${values.publicUrl ?? values.localUrl}`,
          "unlocalhost normalizes same-origin Next.js development assets and HMR at the proxy boundary.",
          "No allowedDevOrigins or Caddy setting needs to be hardcoded in the project.",
        ],
      },
    ];
  }
  if (detection.devServer === "angular") {
    return [
      {
        level: "info",
        title: "Angular development endpoint configured",
        lines: [
          `Endpoint: ${values.publicUrl ?? values.localUrl}`,
          "unlocalhost adapts the upstream Host and proxies live reload through the application origin.",
          "No serve.allowedHosts or proxy setting needs to be hardcoded in angular.json.",
        ],
      },
    ];
  }
  if (detection.devServer === "astro") {
    return [
      {
        level: "info",
        title: "Astro development endpoint configured",
        lines: [
          `Endpoint: ${values.publicUrl ?? values.localUrl}`,
          "unlocalhost adapts the upstream Host and proxies Vite HMR through the application origin.",
          "No server.allowedHosts or proxy setting needs to be hardcoded in astro.config.",
        ],
      },
    ];
  }
  return [];
}
