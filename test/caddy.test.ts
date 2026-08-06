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
        id: "vite",
        slug: "alpha-vite",
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
    { ...DEFAULT_CONFIG, public_domain: "dev.example.com", machine_alias: "studio" },
    projects,
  );
  assert.match(source, /\tskip_install_trust/);
  assert.match(source, /\tauto_https disable_redirects/);
  assert.match(source, /https:\/\/alpha\.localhost:8443/);
  assert.match(source, /reverse_proxy 127\.0\.0\.1:18081/);
  assert.match(source, /https:\/\/bravo\.localhost:8443/);
  assert.match(source, /reverse_proxy 127\.0\.0\.1:18082/);
  assert.match(source, /http:\/\/alpha-studio\.dev\.example\.com:8080/);
  assert.match(source, /http:\/\/bravo-studio\.dev\.example\.com:8080/);
  assert.match(source, /https:\/\/alpha-vite\.localhost:8443/);
  assert.doesNotMatch(source, /http:\/\/alpha-vite-studio\.dev\.example\.com:8080/);
  assert.match(source, /reverse_proxy 127\.0\.0\.1:18083/);
  assert.match(
    source,
    /https:\/\/alpha-vite\.localhost:8443[\s\S]*?@unlocalhost_cors header Origin https:\/\/alpha\.localhost:8443[\s\S]*?header_up Host 127\.0\.0\.1:18083/,
  );
  assert.match(source, /@unlocalhost_vite_websocket/);
  assert.match(source, /@unlocalhost_vite_assets path \/@vite\/\*/);
  assert.match(source, /"\/projects\/alpha\/\*"/);
  assert.match(
    source,
    /http:\/\/alpha-studio\.dev\.example\.com:8080[\s\S]*?handle @unlocalhost_vite_assets[\s\S]*?reverse_proxy 127\.0\.0\.1:18083/,
  );
  assert.match(
    source,
    /http:\/\/alpha-studio\.dev\.example\.com:8080[\s\S]*?header_up X-Forwarded-Proto https[\s\S]*?header_up X-Forwarded-Port 443/,
  );
  assert.equal(
    (source.match(/# unlocalhost-project:alpha:endpoint:vite/g) ?? []).length,
    2,
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

test("local-only projects do not get a public tunnel route", () => {
  const source = generateCaddyfile(
    { ...DEFAULT_CONFIG, public_domain: "dev.example.com", machine_alias: "studio" },
    [{ ...projects[0]!, public_enabled: false }],
  );
  assert.match(source, /https:\/\/alpha\.localhost:8443/);
  assert.doesNotMatch(source, /alpha-studio\.dev\.example\.com/);
});

test("dev cache bypass headers are limited to public tunnel routes", () => {
  const source = generateCaddyfile(
    { ...DEFAULT_CONFIG, public_domain: "dev.example.com", machine_alias: "studio" },
    [
      {
        ...projects[1]!,
        id: "dev-app",
        slug: "dev-app",
        dev_mode: true,
      },
    ],
  );
  const localHttp = source.slice(
    source.indexOf("http://dev-app.localhost:8080"),
    source.indexOf("https://dev-app.localhost:8443"),
  );
  const localHttps = source.slice(
    source.indexOf("https://dev-app.localhost:8443"),
    source.indexOf("http://dev-app-studio.dev.example.com:8080"),
  );
  const publicRoute = source.slice(
    source.indexOf("http://dev-app-studio.dev.example.com:8080"),
  );

  assert.doesNotMatch(localHttp, /Cache-Control/);
  assert.doesNotMatch(localHttps, /Cache-Control/);
  assert.match(
    publicRoute,
    /header_down Cache-Control "private, no-cache, must-revalidate, max-age=0"/,
  );
  assert.doesNotMatch(publicRoute, /header_down Cache-Control "[^"]*no-store/);
  assert.match(publicRoute, /header_down Pragma "no-cache"/);
  assert.match(publicRoute, /header_down Expires "0"/);
  assert.match(publicRoute, /header_down Surrogate-Control "no-store"/);
  assert.match(publicRoute, /header_down CDN-Cache-Control "no-store"/);
  assert.match(publicRoute, /header_down Cloudflare-CDN-Cache-Control "no-store"/);
});

test("managed commands bypass public edge caching without changing production-like routes", () => {
  const source = generateCaddyfile(
    { ...DEFAULT_CONFIG, public_domain: "dev.example.com", machine_alias: "studio" },
    [
      {
        ...projects[1]!,
        id: "runner",
        slug: "runner",
        run_command: ["npm", "run", "dev"],
      },
      {
        ...projects[1]!,
        id: "release",
        slug: "release",
      },
    ],
  );
  const runnerRoute = source.slice(
    source.indexOf("http://runner-studio.dev.example.com:8080"),
    source.indexOf("# unlocalhost-project:release"),
  );
  const releaseRoute = source.slice(
    source.indexOf("http://release-studio.dev.example.com:8080"),
  );

  assert.match(runnerRoute, /header_down Cloudflare-CDN-Cache-Control "no-store"/);
  assert.doesNotMatch(releaseRoute, /header_down .*Cache-Control/);
});
