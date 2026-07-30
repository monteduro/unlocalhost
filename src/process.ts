import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { SpawnOptions } from "node:child_process";
import type { CommandResult } from "./types.js";

export function commandExists(command: string): boolean {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return result.status === 0 || result.status === 1;
}

export function resolveExecutable(command: string): string {
  if (command.includes(path.sep)) return command;
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return command;
}

export async function runCommand(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }),
    );
  });
}

export async function runForeground(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
