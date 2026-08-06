import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("README states the remote-development purpose and links the full guide", async () => {
  const [readme, overview] = await Promise.all([
    fs.readFile("README.md", "utf8"),
    fs.readFile("docs/assets/unlocalhost-overview.jpeg"),
  ]);

  assert.match(readme, /docs\/assets\/unlocalhost-overview\.jpeg/);
  assert.deepEqual([...overview.subarray(0, 3)], [255, 216, 255]);
  assert.match(readme, /Develop locally\. Work from anywhere\./);
  assert.match(readme, /Nothing is deployed\./);
  assert.match(readme, /one optional tunnel serve every project on a machine/);
  assert.match(readme, /Multiple machines stay independent/);
  assert.match(readme, /exact DNS\s+records to delete manually/);
  assert.match(readme, /npm install --global unlocalhost-cli@alpha/);
  assert.match(readme, /npmjs\.com\/package\/unlocalhost-cli/);
  assert.match(readme, /github\.com\/monteduro\/unlocalhost\/tags/);
  assert.match(readme, /Caddy, always/);
  assert.match(readme, /npm package installs only the CLI/);
  assert.match(readme, /never installs Homebrew or Docker/);
  assert.match(readme, /unlocalhost setup/);
  assert.match(readme, /What do you want to enable\?/);
  assert.match(readme, /--features https,dev,remote/);
  assert.match(readme, /never patches tracked source or configuration/);
  assert.match(readme, /\[GUIDE\.md\]\(GUIDE\.md\)/);
  assert.ok(readme.split("\n").length < 150, "README should remain a concise entry point");
});

test("the packaged guide covers operations, agents, and troubleshooting", async () => {
  const [guide, packageJson] = await Promise.all([
    fs.readFile("GUIDE.md", "utf8"),
    fs.readFile("package.json", "utf8"),
  ]);
  const packageConfig = JSON.parse(packageJson) as { files?: string[] };

  assert.match(guide, /npm install --global unlocalhost-cli@alpha/);
  assert.match(guide, /Caddy for every setup/);
  assert.match(guide, /never installs Homebrew itself/);
  assert.match(guide, /one\s+Cloudflare Tunnel per machine/);
  assert.match(guide, /exact CNAME for every independently addressable public endpoint/);
  assert.match(guide, /prints every exact hostname as a\s+manual Cloudflare-dashboard action/);
  assert.match(guide, /absolute project path and gets `404`/);

  for (const heading of [
    "## Remote access with Cloudflare",
    "## Register a Compose project",
    "## Vite and other Node development servers",
    "## Laravel behind the proxy",
    "## Agent and automation workflow",
    "## Troubleshooting",
  ]) {
    assert.ok(guide.includes(heading), `GUIDE.md is missing ${heading}`);
  }
  assert.ok(packageConfig.files?.includes("GUIDE.md"));
});
