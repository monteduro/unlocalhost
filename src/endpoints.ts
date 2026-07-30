import type { EndpointConfig, ProjectConfig } from "./types.js";

export interface ResolvedEndpoint extends EndpointConfig {
  primary: boolean;
}

export function projectEndpoints(project: ProjectConfig): ResolvedEndpoint[] {
  return [
    {
      id: "web",
      slug: project.slug,
      ...(project.run_command ? { run_command: project.run_command } : {}),
      ...(project.compose_service
        ? {
            compose_service: project.compose_service,
            container_port: project.container_port,
          }
        : {}),
      upstream: project.upstream,
      primary: true,
    },
    ...project.endpoints.map((endpoint) => ({ ...endpoint, primary: false })),
  ];
}

export function getEndpoint(project: ProjectConfig, id: string): ResolvedEndpoint | undefined {
  return projectEndpoints(project).find((endpoint) => endpoint.id === id);
}
