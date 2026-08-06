import assert from "node:assert/strict";
import test from "node:test";
import { ensureSetupDependency } from "../src/dependencies.js";

test("setup dependencies that are already available do not prompt or install", async () => {
  let prompted = false;
  let installed = false;
  const result = await ensureSetupDependency("caddy", {
    interactive: true,
    confirmInstall: async () => {
      prompted = true;
      return true;
    },
    runtime: {
      platform: "darwin",
      commandExists: (command) => command === "caddy",
      runForeground: async () => {
        installed = true;
        return 0;
      },
    },
  });

  assert.deepEqual(result, { dependency: "caddy", installed: false });
  assert.equal(prompted, false);
  assert.equal(installed, false);
});

test("non-interactive setup never invokes Homebrew", async () => {
  const checked: string[] = [];
  let installed = false;
  await assert.rejects(
    ensureSetupDependency("caddy", {
      interactive: false,
      runtime: {
        platform: "darwin",
        commandExists: (command) => {
          checked.push(command);
          return command === "brew";
        },
        runForeground: async () => {
          installed = true;
          return 0;
        },
      },
    }),
    /Caddy is required but was not found/,
  );
  assert.deepEqual(checked, ["caddy", "brew"]);
  assert.equal(installed, false);
});

test("macOS without Homebrew points to official installation instructions", async () => {
  await assert.rejects(
    ensureSetupDependency("caddy", {
      interactive: true,
      confirmInstall: async () => true,
      runtime: {
        platform: "darwin",
        commandExists: () => false,
        runForeground: async () => 0,
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /caddyserver\.com\/docs\/install/);
      assert.doesNotMatch(error.message, /brew install caddy/);
      return true;
    },
  );
});

test("interactive macOS setup installs a missing dependency with confirmed Homebrew", async () => {
  let dependencyAvailable = false;
  const commands: Array<[string, string[]]> = [];
  const result = await ensureSetupDependency("cloudflared", {
    interactive: true,
    confirmInstall: async (message) => {
      assert.match(message, /required for remote access/);
      return true;
    },
    runtime: {
      platform: "darwin",
      commandExists: (command) => command === "brew" || (command === "cloudflared" && dependencyAvailable),
      runForeground: async (command, args) => {
        commands.push([command, args]);
        dependencyAvailable = true;
        return 0;
      },
    },
  });

  assert.deepEqual(commands, [["brew", ["install", "cloudflared"]]]);
  assert.deepEqual(result, { dependency: "cloudflared", installed: true });
});

test("declining Homebrew leaves the dependency missing", async () => {
  let installed = false;
  await assert.rejects(
    ensureSetupDependency("caddy", {
      interactive: true,
      confirmInstall: async () => false,
      runtime: {
        platform: "darwin",
        commandExists: (command) => command === "brew",
        runForeground: async () => {
          installed = true;
          return 0;
        },
      },
    }),
    /Caddy is required but was not found/,
  );
  assert.equal(installed, false);
});

test("a failed Homebrew installation reports the original dependency help", async () => {
  await assert.rejects(
    ensureSetupDependency("cloudflared", {
      interactive: true,
      confirmInstall: async () => true,
      runtime: {
        platform: "darwin",
        commandExists: (command) => command === "brew",
        runForeground: async () => 7,
      },
    }),
    /Homebrew could not install cloudflared \(exit code 7\)[\s\S]*brew install cloudflared/,
  );
});
