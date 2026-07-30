import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { UnlocalhostError } from "./errors.js";

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string, mode = 0o700): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode });
}

export async function writeAtomic(
  file: string,
  contents: string,
  mode = 0o600,
): Promise<void> {
  await ensureDir(path.dirname(file));
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, contents, { encoding: "utf8", mode });
  await fs.rename(temporary, file);
  await fs.chmod(file, mode);
}

export function assertInside(parent: string, child: string, description: string): void {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new UnlocalhostError(`${description} must be inside ${parent}`);
  }
}
