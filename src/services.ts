import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UnlocalhostError } from "./errors.js";
import { ensureDir, exists, writeAtomic } from "./files.js";
import { pathsFor } from "./paths.js";
import { resolveExecutable, runCommand } from "./process.js";

export type ServiceKind = "proxy" | "tunnel";

interface ServiceDefinition {
  label: string;
  description: string;
  executable: string;
  args: string[];
  stdout: string;
  stderr: string;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function serviceDefinition(home: string, kind: ServiceKind, tunnelId?: string): ServiceDefinition {
  const paths = pathsFor(home);
  if (kind === "proxy") {
    return {
      label: "io.unlocalhost.caddy",
      description: "unlocalhost Caddy reverse proxy",
      executable: resolveExecutable("caddy"),
      args: ["run", "--config", paths.caddyfile, "--adapter", "caddyfile"],
      stdout: path.join(paths.logs, "caddy.out.log"),
      stderr: path.join(paths.logs, "caddy.err.log"),
    };
  }
  if (!tunnelId) throw new UnlocalhostError("Tunnel is not initialized");
  return {
    label: "io.unlocalhost.cloudflared",
    description: "unlocalhost Cloudflare tunnel",
    executable: resolveExecutable("cloudflared"),
    args: ["tunnel", "--config", paths.cloudflaredConfig, "run", tunnelId],
    stdout: path.join(paths.logs, "cloudflared.out.log"),
    stderr: path.join(paths.logs, "cloudflared.err.log"),
  };
}

function launchAgentFile(definition: ServiceDefinition): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${definition.label}.plist`);
}

function systemdFile(definition: ServiceDefinition): string {
  return path.join(os.homedir(), ".config", "systemd", "user", `${definition.label}.service`);
}

async function archiveLegacyServiceFile(file: string): Promise<void> {
  if (!(await exists(file))) return;
  let archived = `${file}.disabled-by-unlocalhost`;
  if (await exists(archived)) archived = `${archived}-${Date.now()}`;
  await fs.rename(file, archived);
}

async function disableLegacyProxyService(): Promise<void> {
  const legacyLabel = "io.devhost.caddy";
  if (process.platform === "darwin") {
    const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
    const running = await runCommand("launchctl", ["print", `${domain}/${legacyLabel}`]);
    if (running.code === 0) {
      await launchctl(["bootout", `${domain}/${legacyLabel}`]);
      await waitForLaunchAgentUnload(domain, legacyLabel);
    }
    await archiveLegacyServiceFile(
      path.join(os.homedir(), "Library", "LaunchAgents", `${legacyLabel}.plist`),
    );
    return;
  }
  if (process.platform === "linux") {
    const file = path.join(
      os.homedir(),
      ".config",
      "systemd",
      "user",
      `${legacyLabel}.service`,
    );
    const hadLegacyUnit = await exists(file);
    await runCommand("systemctl", ["--user", "disable", "--now", legacyLabel]);
    await archiveLegacyServiceFile(file);
    if (hadLegacyUnit) await systemctl(["daemon-reload"]);
  }
}

function plist(definition: ServiceDefinition): string {
  const args = [definition.executable, ...definition.args]
    .map((arg) => `      <string>${xml(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${definition.label}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>${xml(definition.stdout)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(definition.stderr)}</string>
  </dict>
</plist>
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function systemdUnit(definition: ServiceDefinition): string {
  const command = [definition.executable, ...definition.args].map(shellQuote).join(" ");
  return `[Unit]
Description=${definition.description}
After=network-online.target

[Service]
ExecStart=${command}
Restart=always
RestartSec=5
StandardOutput=append:${definition.stdout}
StandardError=append:${definition.stderr}

[Install]
WantedBy=default.target
`;
}

async function launchctl(args: string[]): Promise<void> {
  const result = await runCommand("launchctl", args);
  if (result.code !== 0) throw new UnlocalhostError(result.stderr || result.stdout || "launchctl failed");
}

async function waitForLaunchAgentUnload(domain: string, label: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await runCommand("launchctl", ["print", `${domain}/${label}`]);
    if (result.code !== 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function bootstrapLaunchAgent(domain: string, file: string): Promise<void> {
  let lastError = "launchctl bootstrap failed";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await runCommand("launchctl", ["bootstrap", domain, file]);
    if (result.code === 0) return;
    lastError = result.stderr || result.stdout || lastError;
    if (!/Bootstrap failed: 5|Input\/output error/i.test(lastError)) break;
    await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }
  throw new UnlocalhostError(lastError);
}

async function systemctl(args: string[]): Promise<void> {
  const result = await runCommand("systemctl", ["--user", ...args]);
  if (result.code !== 0) throw new UnlocalhostError(result.stderr || result.stdout || "systemctl failed");
}

export async function installService(
  home: string,
  kind: ServiceKind,
  tunnelId?: string,
): Promise<string> {
  if (kind === "proxy") await disableLegacyProxyService();
  const definition = serviceDefinition(home, kind, tunnelId);
  await ensureDir(pathsFor(home).logs);
  if (process.platform === "darwin") {
    const file = launchAgentFile(definition);
    await ensureDir(path.dirname(file));
    const desired = plist(definition);
    const existingContent = await fs.readFile(file, "utf8").catch(() => null);
    const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
    const existing = await runCommand("launchctl", ["print", `${domain}/${definition.label}`]);
    if (existingContent === desired && existing.code === 0) return file;
    if (existing.code === 0) {
      await launchctl(["bootout", `${domain}/${definition.label}`]);
      await waitForLaunchAgentUnload(domain, definition.label);
    }
    await writeAtomic(file, desired, 0o600);
    await bootstrapLaunchAgent(domain, file);
    return file;
  }
  if (process.platform === "linux") {
    const file = systemdFile(definition);
    await ensureDir(path.dirname(file));
    await writeAtomic(file, systemdUnit(definition), 0o600);
    await systemctl(["daemon-reload"]);
    await systemctl(["enable", "--now", definition.label]);
    return file;
  }
  throw new UnlocalhostError("Service installation is supported on macOS and Linux only");
}

export async function uninstallService(
  home: string,
  kind: ServiceKind,
  tunnelId?: string,
): Promise<string> {
  const definition = serviceDefinition(home, kind, tunnelId);
  if (process.platform === "darwin") {
    const file = launchAgentFile(definition);
    const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
    if (await serviceRunning(home, kind, tunnelId)) {
      await launchctl(["bootout", `${domain}/${definition.label}`]);
    }
    await fs.rm(file, { force: true });
    return file;
  }
  if (process.platform === "linux") {
    const file = systemdFile(definition);
    await runCommand("systemctl", ["--user", "disable", "--now", definition.label]);
    await fs.rm(file, { force: true });
    await systemctl(["daemon-reload"]);
    return file;
  }
  throw new UnlocalhostError("Service uninstallation is supported on macOS and Linux only");
}

export async function serviceInstalled(
  home: string,
  kind: ServiceKind,
  tunnelId?: string,
): Promise<boolean> {
  const definition = serviceDefinition(home, kind, tunnelId);
  if (process.platform === "darwin") return await exists(launchAgentFile(definition));
  if (process.platform === "linux") return await exists(systemdFile(definition));
  return false;
}

export async function serviceRunning(
  home: string,
  kind: ServiceKind,
  tunnelId?: string,
): Promise<boolean> {
  const definition = serviceDefinition(home, kind, tunnelId);
  if (process.platform === "darwin") {
    const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
    return (await runCommand("launchctl", ["print", `${domain}/${definition.label}`])).code === 0;
  }
  if (process.platform === "linux") {
    return (await runCommand("systemctl", ["--user", "is-active", definition.label])).code === 0;
  }
  return false;
}

export async function serviceAction(
  home: string,
  kind: ServiceKind,
  action: "start" | "stop" | "restart",
  tunnelId?: string,
): Promise<void> {
  const definition = serviceDefinition(home, kind, tunnelId);
  if (!(await serviceInstalled(home, kind, tunnelId))) {
    throw new UnlocalhostError(`${kind} service is not installed`);
  }
  if (process.platform === "darwin") {
    const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
    const target = `${domain}/${definition.label}`;
    const file = launchAgentFile(definition);
    const running = await serviceRunning(home, kind, tunnelId);
    if (action === "stop" && running) await launchctl(["bootout", target]);
    if (action === "start" && !running) await launchctl(["bootstrap", domain, file]);
    if (action === "restart") {
      if (running) await launchctl(["bootout", target]);
      await launchctl(["bootstrap", domain, file]);
    }
    return;
  }
  if (process.platform === "linux") {
    await systemctl([action, definition.label]);
    return;
  }
  throw new UnlocalhostError("Service control is supported on macOS and Linux only");
}
