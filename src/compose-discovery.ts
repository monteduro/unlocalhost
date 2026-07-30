import fs from "node:fs/promises";
import path from "node:path";
import { dependencyHelp } from "./dependencies.js";
import { UnlocalhostError } from "./errors.js";
import { assertInside, exists } from "./files.js";
import { commandExists, runCommand } from "./process.js";

const DEFAULT_COMPOSE_FILES = [
  "compose.yml",
  "compose.yaml",
  "docker-compose.yml",
  "docker-compose.yaml",
] as const;

export interface ComposeCandidate {
  service: string;
  containerPort: number;
  source: "ports" | "expose";
}

export interface ComposeDiscovery {
  composeFile: string;
  candidates: ComposeCandidate[];
  publishedServices: string[];
}

interface ComposeService {
  ports?: unknown;
  expose?: unknown;
}

function numericPort(value: unknown): number | null {
  const stringMatch =
    typeof value === "string" ? value.match(/^(\d+)(?:\/tcp)?$/) : null;
  const parsed =
    typeof value === "number"
      ? value
      : stringMatch
        ? Number(stringMatch[1])
        : NaN;
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : null;
}

export function parseComposeCandidates(value: unknown): ComposeCandidate[] {
  if (!value || typeof value !== "object") {
    throw new UnlocalhostError("Docker Compose returned an invalid configuration");
  }
  const services = (value as { services?: unknown }).services;
  if (!services || typeof services !== "object" || Array.isArray(services)) {
    throw new UnlocalhostError("Docker Compose configuration contains no services");
  }

  const candidates: ComposeCandidate[] = [];
  for (const [service, rawService] of Object.entries(services)) {
    if (!rawService || typeof rawService !== "object" || Array.isArray(rawService)) continue;
    const definition = rawService as ComposeService;
    const discovered = new Map<number, "ports" | "expose">();

    if (Array.isArray(definition.ports)) {
      for (const rawPort of definition.ports) {
        if (!rawPort || typeof rawPort !== "object" || Array.isArray(rawPort)) continue;
        const port = rawPort as { target?: unknown; protocol?: unknown };
        if (port.protocol !== undefined && port.protocol !== "tcp") continue;
        const target = numericPort(port.target);
        if (target !== null) discovered.set(target, "ports");
      }
    }
    if (Array.isArray(definition.expose)) {
      for (const rawPort of definition.expose) {
        const target = numericPort(rawPort);
        if (target !== null && !discovered.has(target)) discovered.set(target, "expose");
      }
    }

    for (const [containerPort, source] of discovered) {
      candidates.push({ service, containerPort, source });
    }
  }
  return candidates;
}

export function parsePublishedServices(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const services = (value as { services?: unknown }).services;
  if (!services || typeof services !== "object" || Array.isArray(services)) return [];
  return Object.entries(services)
    .filter(([, rawService]) => {
      if (!rawService || typeof rawService !== "object" || Array.isArray(rawService)) {
        return false;
      }
      const ports = (rawService as ComposeService).ports;
      return Array.isArray(ports) && ports.length > 0;
    })
    .map(([service]) => service);
}

export async function detectComposeFile(projectPath: string): Promise<string | null> {
  const root = path.resolve(projectPath);
  for (const filename of DEFAULT_COMPOSE_FILES) {
    if (await exists(path.join(root, filename))) return filename;
  }
  return null;
}

export async function inspectCompose(
  projectPath: string,
  requestedFile?: string,
): Promise<ComposeDiscovery> {
  const root = path.resolve(projectPath);
  const composeFile = requestedFile ?? (await detectComposeFile(root));
  if (!composeFile) {
    throw new UnlocalhostError(
      `No Compose file found in ${root}; expected ${DEFAULT_COMPOSE_FILES.join(", ")}`,
    );
  }
  const absoluteCompose = path.resolve(root, composeFile);
  assertInside(root, absoluteCompose, "Compose file");
  const stat = await fs.stat(absoluteCompose).catch(() => null);
  if (!stat?.isFile()) throw new UnlocalhostError(`Compose file does not exist: ${absoluteCompose}`);
  if (!commandExists("docker")) throw new UnlocalhostError(dependencyHelp("docker"));

  const result = await runCommand("docker", [
    "compose",
    "--project-directory",
    root,
    "-f",
    absoluteCompose,
    "config",
    "--format",
    "json",
  ]);
  if (result.code !== 0) {
    const detail = result.stderr || result.stdout || "unknown Docker error";
    throw new UnlocalhostError(
      `Could not inspect ${path.basename(absoluteCompose)}: ${detail}\nMake sure Docker Desktop or the Docker daemon is running.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new UnlocalhostError("Docker Compose returned invalid JSON while inspecting the project");
  }
  const candidates = parseComposeCandidates(parsed);
  return {
    composeFile: path.relative(root, absoluteCompose) || path.basename(absoluteCompose),
    candidates,
    publishedServices: parsePublishedServices(parsed),
  };
}

export async function discoverCompose(
  projectPath: string,
  requestedFile?: string,
): Promise<ComposeDiscovery> {
  const discovery = await inspectCompose(projectPath, requestedFile);
  const { candidates } = discovery;
  if (candidates.length === 0) {
    throw new UnlocalhostError(
      `No TCP ports were declared with "ports" or "expose" in ${path.basename(discovery.composeFile)}. Specify the HTTP endpoint with --service <name> --container-port <port>.`,
    );
  }
  return discovery;
}

function candidateLabel(candidate: ComposeCandidate): string {
  return `${candidate.service}:${candidate.containerPort}`;
}

export function selectComposeCandidates(
  candidates: ComposeCandidate[],
  selection: string,
): ComposeCandidate[] {
  const tokens = selection
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new UnlocalhostError("--services cannot be empty");
  }

  const selected: ComposeCandidate[] = [];
  for (const token of tokens) {
    const exact = candidates.filter((candidate) => candidateLabel(candidate) === token);
    const byService = candidates.filter((candidate) => candidate.service === token);
    const matches = exact.length > 0 ? exact : byService;
    if (matches.length === 0) {
      throw new UnlocalhostError(
        `Unknown Compose service or endpoint "${token}". Available: ${candidates.map(candidateLabel).join(", ")}`,
      );
    }
    if (exact.length === 0 && matches.length > 1) {
      throw new UnlocalhostError(
        `Service "${token}" exposes multiple ports; choose one as ${token}:<port>`,
      );
    }
    const candidate = matches[0]!;
    if (!selected.some((item) => candidateLabel(item) === candidateLabel(candidate))) {
      selected.push(candidate);
    }
  }
  return selected;
}

export function formatComposeCandidates(candidates: ComposeCandidate[]): string {
  return candidates
    .map(
      (candidate, index) =>
        `${index + 1}) ${candidate.service}:${candidate.containerPort} (${candidate.source})`,
    )
    .join("\n");
}

export function selectComposeCandidateNumbers(
  candidates: ComposeCandidate[],
  answer: string,
): ComposeCandidate[] {
  const indices = answer
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .map(Number);
  if (
    indices.length === 0 ||
    indices.some(
      (index) => !Number.isInteger(index) || index < 1 || index > candidates.length,
    )
  ) {
    throw new UnlocalhostError(
      `Invalid selection; enter comma-separated numbers from 1 to ${candidates.length}`,
    );
  }
  return indices
    .filter((index, position) => indices.indexOf(index) === position)
    .map((index) => candidates[index - 1]!);
}
