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

test("root help exposes setup as the primary human and agent workflow", () => {
  const output = runHelp(["--help"]);

  assert.match(output, /Agent-ready workflow:/);
  assert.match(output, /unlocalhost --yes setup "\$PWD"/);
  assert.match(output, /--features https,dev,remote/);
  assert.match(output, /unlocalhost --json status <slug>/);
  assert.match(output, /interactive wizard/);
});

test("setup help promises goal-first setup without port decisions", () => {
  const output = runHelp(["setup", "--help"]);

  assert.match(output, /goal-oriented wizard/);
  assert.match(output, /--features <list>/);
  assert.match(output, /checkbox list/);
  assert.match(output, /--machine <alias>/);
  assert.match(output, /Ports, loopback mappings, Caddy routes/);
  assert.match(output, /exact project DNS/);
  assert.match(output, /source and configuration are never edited/);
  assert.match(output, /Static public\/index\.html projects/);
  assert.match(output, /unknown stacks ask for the start\s+command/);
});

test("endpoint help explains host and Compose Vite registration", () => {
  const output = runHelp(["endpoint", "add", "--help"]);

  assert.match(output, /Vite runs inside a Compose service/);
  assert.match(output, /--service web --container-port 5173/);
  assert.match(output, /Vite runs directly on the host/);
  assert.match(output, /shares the application's browser hostname/);
  assert.match(output, /no second public DNS record/);
  assert.match(output, /unlocalhost up" starts the Compose stack/);
  assert.match(output, /Port already in use/);
  assert.match(output, /Next, Webpack/);
});
