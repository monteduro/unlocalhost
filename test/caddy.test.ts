import assert from "node:assert/strict";
import test from "node:test";
import { generateCaddyfile } from "../src/caddy.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { ProjectConfig } from "../src/types.js";

const projects: ProjectConfig[] = [
  {
    id: "alpha",
    name: "Alpha",
    path: "/projects/alpha",
    slug: "alpha",
    enabled: true,
    endpoints: [
      {
        id: "api",
        slug: "alpha-api",
        upstream: { mode: "host_port", host: "127.0.0.1", port: 18083 },
      },
    ],
    upstream: { mode: "host_port", host: "127.0.0.1", port: 18081 },
  },
  {
    id: "bravo",
    name: "Bravo",
    path: "/projects/bravo",
    slug: "bravo",
    enabled: true,
    endpoints: [],
    upstream: { mode: "host_port", host: "127.0.0.1", port: 18082 },
  },
];

test("Caddyfile contains two local HTTPS and public HTTP routes", () => {
  const source = generateCaddyfile(
    { ...DEFAULT_CONFIG, public_domain: "dev.example.com" },
    projects,
  );
  assert.match(source, /\tskip_install_trust/);
  assert.match(source, /https:\/\/alpha\.localhost:8443/);
  assert.match(source, /reverse_proxy 127\.0\.0\.1:18081/);
  assert.match(source, /https:\/\/bravo\.localhost:8443/);
  assert.match(source, /reverse_proxy 127\.0\.0\.1:18082/);
  assert.match(source, /http:\/\/alpha\.dev\.example\.com:8080/);
  assert.match(source, /http:\/\/bravo\.dev\.example\.com:8080/);
  assert.match(source, /https:\/\/alpha-api\.localhost:8443/);
  assert.match(source, /http:\/\/alpha-api\.dev\.example\.com:8080/);
  assert.match(source, /reverse_proxy 127\.0\.0\.1:18083/);
  assert.match(
    source,
    /http:\/\/alpha\.dev\.example\.com:8080[\s\S]*?header_up X-Forwarded-Proto https[\s\S]*?header_up X-Forwarded-Port 443/,
  );
  assert.equal(
    (source.match(/# unlocalhost-project:alpha:endpoint:api/g) ?? []).length,
    3,
  );
  assert.equal((source.match(/# unlocalhost-project:alpha\n/g) ?? []).length, 3);
  assert.equal((source.match(/# unlocalhost-project:bravo\n/g) ?? []).length, 3);
});

test("disabled projects do not get routes", () => {
  const source = generateCaddyfile(DEFAULT_CONFIG, [
    { ...projects[0]!, enabled: false },
  ]);
  assert.doesNotMatch(source, /unlocalhost-project:alpha/);
  assert.match(source, /No unlocalhost projects are registered/);
});
