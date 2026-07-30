import path from "node:path";
import { inspectCompose } from "./compose-discovery.js";
import { dependencyHelp } from "./dependencies.js";
import { UnlocalhostError } from "./errors.js";
import { assertInside, exists } from "./files.js";
import { pathsFor } from "./paths.js";
import { commandExists, runCommand } from "./process.js";
import { setComposePortServices } from "./registry.js";
import type { ProjectConfig } from "./types.js";

export function composeSupportsPortOverride(version: string): boolean {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const current = [Number(match[1]), Number(match[2]), Number(match[3])];
  const minimum = [2, 24, 4];
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index]! > minimum[index]!) return true;
    if (current[index]! < minimum[index]!) return false;
  }
  return true;
}

async function requirePortOverrideSupport(): Promise<void> {
  const result = await runCommand("docker", ["compose", "version", "--short"]);
  if (result.code !== 0 || !composeSupportsPortOverride(result.stdout)) {
    throw new UnlocalhostError(
      `unlocalhost requires Docker Compose 2.24.4 or newer to replace conflicting project ports safely; found ${result.stdout || result.stderr || "an unknown version"}. Update Docker Desktop or the Compose plugin.`,
    );
  }
}

export async function runCompose(
  home: string,
  project: ProjectConfig,
  operation: "up" | "down",
): Promise<void> {
  if (!commandExists("docker")) {
    throw new UnlocalhostError(dependencyHelp("docker"));
  }
  if (!project.compose_file) {
    throw new UnlocalhostError(
      `Project "${project.id}" has no Compose file; manage its upstream process separately`,
    );
  }
  if (project.compose_override) await requirePortOverrideSupport();
  let effectiveProject = project;
  if (project.compose_port_services === undefined) {
    const inspection = await inspectCompose(project.path, project.compose_file);
    effectiveProject = await setComposePortServices(
      home,
      project.id,
      inspection.publishedServices,
    );
  }
  const compose = path.resolve(effectiveProject.path, effectiveProject.compose_file!);
  assertInside(effectiveProject.path, compose, "Compose file");
  if (!(await exists(compose))) throw new UnlocalhostError(`Compose file not found: ${compose}`);
  if (effectiveProject.compose_override) {
    assertInside(pathsFor(home).overrides, effectiveProject.compose_override, "Compose override");
    if (!(await exists(effectiveProject.compose_override))) {
      throw new UnlocalhostError(`Compose override not found: ${effectiveProject.compose_override}`);
    }
  }
  const result = await runCommand(
    "docker",
    composeArgsForHome(home, effectiveProject, operation),
  );
  if (result.code !== 0) {
    throw new UnlocalhostError(
      `docker compose ${operation} failed for "${project.id}": ${result.stderr || result.stdout}`,
    );
  }
}

export function composeArgsForHome(
  home: string,
  project: ProjectConfig,
  operation: "up" | "down" | "ps",
): string[] {
  if (!project.compose_file) throw new UnlocalhostError(`Project "${project.id}" has no compose_file`);
  const compose = path.resolve(project.path, project.compose_file);
  assertInside(project.path, compose, "Compose file");
  const args = ["compose", "--project-directory", project.path, "-f", compose];
  if (project.compose_override) {
    assertInside(pathsFor(home).overrides, project.compose_override, "Compose override");
    args.push("-f", project.compose_override);
  }
  if (operation === "up") args.push("up", "-d");
  if (operation === "down") args.push("down");
  if (operation === "ps") args.push("ps", "--status", "running", "--services");
  return args;
}

export async function composeStatus(
  home: string,
  project: ProjectConfig,
): Promise<{ running: boolean | null; services: string[]; error: string | null }> {
  if (!project.compose_file) return { running: null, services: [], error: null };
  if (!commandExists("docker")) {
    return { running: false, services: [], error: "docker is unavailable" };
  }
  const result = await runCommand("docker", composeArgsForHome(home, project, "ps"));
  if (result.code !== 0) {
    return { running: false, services: [], error: result.stderr || result.stdout };
  }
  const services = result.stdout.split(/\r?\n/).filter(Boolean);
  return { running: services.length > 0, services, error: null };
}
