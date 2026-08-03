import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  generateCloudflaredConfig,
  projectPublicHostnames,
} from "../src/tunnel.js";
import { machinePublicSlug } from "../src/urls.js";
import type { ProjectConfig } from "../src/types.js";

test("cloudflared config sends this machine's exact DNS routes to Caddy", () => {
  const config = {
    ...DEFAULT_CONFIG,
    public_domain: "dev.example.com",
    machine_id: "host-009-a1b2c3",
    machine_alias: "studio",
    dns_mode: "project" as const,
    tunnel_enabled: true,
  };
  const source = generateCloudflaredConfig(
    "/tmp/unlocalhost",
    config,
    "00000000-1111-2222-3333-444444444444",
  );
  assert.match(source, /service: http:\/\/127\.0\.0\.1:8080/);
  assert.doesNotMatch(source, /hostname:/);
  assert.doesNotMatch(source, /\*\.dev\.example\.com/);

  const project: ProjectConfig = {
    id: "alpha",
    name: "Alpha",
    path: "/tmp/alpha",
    slug: "alpha",
    enabled: true,
    public_enabled: true,
    endpoints: [
      {
        id: "vite",
        slug: "alpha-vite",
        upstream: { mode: "host_port", host: "127.0.0.1", port: 12001 },
      },
    ],
    upstream: { mode: "host_port", host: "127.0.0.1", port: 12000 },
  };
  assert.deepEqual(projectPublicHostnames(config, [project]), [
    "alpha-studio.dev.example.com",
  ]);
  const long = machinePublicSlug("a".repeat(63), config.machine_alias);
  assert.equal(long.length, 63);
  assert.match(long, /-[a-f0-9]{6}-studio$/);
});
