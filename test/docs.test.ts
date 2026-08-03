import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("README states the remote-development purpose and links the full guide", async () => {
  const readme = await fs.readFile("README.md", "utf8");

  assert.match(readme, /Develop locally\. Work from anywhere\./);
  assert.match(readme, /Nothing is deployed\./);
  assert.match(readme, /one optional wildcard tunnel serve every project/);
  assert.match(readme, /npm install --global unlocalhost-cli@alpha/);
  assert.match(readme, /Then paste this prompt into your coding agent/);
  assert.match(readme, /Run unlocalhost doctor first/);
  assert.match(readme, /If the project uses Vite/);
  assert.match(readme, /does not use Vite, skip\s+the entire Vite setup/);
  assert.match(readme, /server\.ws on Vite\s+8; server\.hmr on older versions/);
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
