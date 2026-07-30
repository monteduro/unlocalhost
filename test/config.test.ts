import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_CONFIG,
  initializeHome,
  loadGlobalConfig,
  parseGlobalConfig,
  parseProject,
  serializeGlobalConfig,
  serializeProject,
} from "../src/config.js";
import type { ProjectConfig } from "../src/types.js";
import { composeSupportsPortOverride } from "../src/compose.js";

test("global config round-trips through TOML", () => {
  const config = {
    ...DEFAULT_CONFIG,
    public_domain: "dev.example.com",
    tunnel_enabled: true,
    caddy_https_port: 9443,
  };
  assert.deepEqual(parseGlobalConfig(serializeGlobalConfig(config)), config);
});

test("project config round-trips through TOML", () => {
  const project: ProjectConfig = {
    id: "alpha",
    name: "Alpha",
    path: "/tmp/alpha",
    slug: "alpha",
    enabled: true,
    endpoints: [
      {
        id: "api",
        slug: "alpha-api",
        upstream: { mode: "host_port", host: "127.0.0.1", port: 18082 },
      },
    ],
    compose_file: "compose.yml",
    compose_override: "/tmp/unlocalhost/overrides/alpha.yml",
    compose_port_services: ["web", "database"],
    upstream: { mode: "host_port", host: "127.0.0.1", port: 18081 },
  };
  assert.deepEqual(parseProject(serializeProject(project)), project);
});

test("init is idempotent and does not overwrite user config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "unlocalhost-config-"));
  const home = path.join(root, "state");
  const first = await initializeHome(home, { caddy_https_port: 9443 });
  const second = await initializeHome(home, { caddy_https_port: 10443 });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal((await loadGlobalConfig(home)).caddy_https_port, 9443);
});

test("configuration rejects hostname and upstream injection", () => {
  assert.throws(
    () =>
      parseGlobalConfig(
        serializeGlobalConfig({ ...DEFAULT_CONFIG, public_domain: "dev.example.com\nrespond 200" }),
      ),
    /Invalid public_domain/,
  );
  assert.throws(
    () =>
      parseProject(`
id = "alpha"
name = "Alpha"
path = "/tmp/alpha"
slug = "alpha"
[upstream]
mode = "host_port"
host = "host.docker.internal"
port = 8080
`),
    /accepts only 127\.0\.0\.1 or localhost/,
  );
});

test("Compose port replacement requires the supported CLI version", () => {
  assert.equal(composeSupportsPortOverride("2.24.3"), false);
  assert.equal(composeSupportsPortOverride("v2.24.4"), true);
  assert.equal(composeSupportsPortOverride("2.40.3-desktop.1"), true);
});
