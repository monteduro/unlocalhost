import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_CONFIG,
  generateMachineId,
  initializeHome,
  loadGlobalConfig,
  parseGlobalConfig,
  parseProject,
  migrateToProjectDns,
  normalizeMachineAlias,
  serializeGlobalConfig,
  serializeProject,
  suggestedMachineAlias,
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
    dev_mode: true,
    dev_server: "vite",
    endpoints: [
      {
        id: "api",
        slug: "alpha-api",
        dev_mode: true,
        dev_server: "generic",
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
  assert.match(first.config.machine_id, /^[a-z0-9-]+$/);
  assert.equal(first.config.machine_alias, "");
  assert.equal(first.config.tunnel_name, `unlocalhost-${first.config.machine_id}`);
});

test("machine aliases are human-selected, normalized DNS labels", () => {
  assert.equal(normalizeMachineAlias("studio-mac"), "studio-mac");
  assert.equal(suggestedMachineAlias("Stefano's Mac.local"), "stefano-s-mac");
  assert.throws(() => normalizeMachineAlias("not valid!"), /machine_alias/);
});

test("legacy wildcard config migrates to a machine-specific tunnel", () => {
  const legacy = parseGlobalConfig(`
default_projects_root = "~/Sites"
caddy_http_port = 8080
caddy_https_port = 8443
port_range_start = 12000
port_range_end = 19999
local_domain_suffix = "localhost"
public_domain = "dev.example.com"
tunnel_enabled = true
tunnel_name = "unlocalhost"
cloudflare_account_id = ""
cloudflare_zone_id = ""
`);
  assert.equal(legacy.dns_mode, "wildcard");
  const migrated = migrateToProjectDns({
    ...legacy,
    machine_id: generateMachineId("Host-009.local", "a1b2c3"),
  });
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.config.machine_id, "host-009-a1b2c3");
  assert.equal(migrated.config.dns_mode, "project");
  assert.equal(migrated.config.tunnel_name, "unlocalhost-host-009-a1b2c3");
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

test("configuration rejects unknown development server kinds", () => {
  assert.throws(
    () =>
      parseProject(`
id = "alpha"
name = "Alpha"
path = "/tmp/alpha"
slug = "alpha"
dev_server = "webpack"
[upstream]
mode = "host_port"
host = "127.0.0.1"
port = 8080
`),
    /expected vite, next, or generic/,
  );
});

test("Compose port replacement requires the supported CLI version", () => {
  assert.equal(composeSupportsPortOverride("2.24.3"), false);
  assert.equal(composeSupportsPortOverride("v2.24.4"), true);
  assert.equal(composeSupportsPortOverride("2.40.3-desktop.1"), true);
});
