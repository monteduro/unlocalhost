import net from "node:net";
import { UnlocalhostError } from "./errors.js";
import { projectEndpoints } from "./endpoints.js";
import type { GlobalConfig, ProjectConfig } from "./types.js";

async function portAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function allocatePort(
  config: GlobalConfig,
  projects: ProjectConfig[],
): Promise<number> {
  const registered = new Set(
    projects.flatMap((project) =>
      projectEndpoints(project).map((endpoint) => endpoint.upstream.port),
    ),
  );
  for (let port = config.port_range_start; port <= config.port_range_end; port += 1) {
    if (!registered.has(port) && (await portAvailable(port))) return port;
  }
  throw new UnlocalhostError(
    `No free port is available in ${config.port_range_start}-${config.port_range_end}; adjust the range in config.toml`,
  );
}
