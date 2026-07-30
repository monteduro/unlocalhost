import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { generateCloudflaredConfig } from "../src/tunnel.js";

test("cloudflared config has one wildcard ingress and one Caddy origin", () => {
  const source = generateCloudflaredConfig(
    "/tmp/unlocalhost",
    { ...DEFAULT_CONFIG, public_domain: "dev.example.com", tunnel_enabled: true },
    "00000000-1111-2222-3333-444444444444",
  );
  assert.match(source, /hostname: "\*\.dev\.example\.com"/);
  assert.match(source, /service: http:\/\/127\.0\.0\.1:8080/);
  assert.match(source, /service: http_status:404/);
  assert.equal((source.match(/hostname:/g) ?? []).length, 1);
  assert.doesNotMatch(source, /alpha\.dev\.example\.com/);
});
