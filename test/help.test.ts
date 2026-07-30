import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

function runHelp(args: string[]): string {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(process.cwd(), "src", "cli.ts"),
      ...args,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("root help exposes the non-interactive agent workflow", () => {
  const output = runHelp(["--help"]);

  assert.match(output, /Agent-ready workflow:/);
  assert.match(output, /unlocalhost --yes add "\$PWD"/);
  assert.match(output, /unlocalhost --json status <slug>/);
  assert.match(output, /no Cloudflare changes/);
});

test("endpoint help explains host and Compose Vite registration", () => {
  const output = runHelp(["endpoint", "add", "--help"]);

  assert.match(output, /Vite runs inside a Compose service/);
  assert.match(output, /--service web --container-port 5173/);
  assert.match(output, /Vite runs directly on the host/);
  assert.match(output, /server\.ws in Vite 8/);
  assert.match(output, /unlocalhost up" starts the Compose stack/);
  assert.match(output, /Port already in use/);
  assert.match(output, /Next, Webpack/);
});
