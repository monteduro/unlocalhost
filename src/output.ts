import type { ProjectStatus } from "./types.js";

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printLine(value: string): void {
  process.stdout.write(`${value}\n`);
}

export function printProjectStatuses(projects: ProjectStatus[]): void {
  if (projects.length === 0) {
    printLine("No projects registered.");
    return;
  }
  for (const project of projects) {
    const compose =
      project.compose.running === null
        ? "external"
        : project.compose.running
          ? `running (${project.compose.services.join(", ") || "compose"})`
          : "stopped";
    printLine(`${project.id}`);
    printLine(`  compose:  ${compose}`);
    for (const endpoint of project.endpoints) {
      const health = endpoint.upstream_health.reachable
        ? `reachable (HTTP ${endpoint.upstream_health.status})`
        : "unreachable";
      printLine(`  ${endpoint.id}${endpoint.primary ? " (primary)" : ""}`);
      printLine(`    local:    ${endpoint.local_url}`);
      if (endpoint.public_url) printLine(`    public:   ${endpoint.public_url}`);
      printLine(`    route:    ${endpoint.proxy_route ? "present" : "missing"}`);
      printLine(`    upstream: ${endpoint.upstream} — ${health}`);
      if (endpoint.process.configured) {
        printLine(
          `    process:  ${endpoint.process.running ? `running (PID ${endpoint.process.pid})` : "stopped"}`,
        );
      }
    }
  }
}
