#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import http, { type Server } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

async function responseFile(root: string, requestUrl: string): Promise<string | null> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, "http://unlocalhost").pathname);
  } catch {
    return null;
  }
  const candidate = path.resolve(root, `.${pathname}`);
  if (!isInside(root, candidate)) return null;
  let stat = await fsp.stat(candidate).catch(() => null);
  const file = stat?.isDirectory() ? path.join(candidate, "index.html") : candidate;
  stat = stat?.isDirectory() ? await fsp.stat(file).catch(() => null) : stat;
  if (!stat?.isFile()) return null;
  const realFile = await fsp.realpath(file).catch(() => null);
  if (!realFile || !isInside(root, realFile)) return null;
  return realFile;
}

export async function startStaticServer(
  rootPath: string,
  host: string,
  port: number,
): Promise<Server> {
  const root = await fsp.realpath(path.resolve(rootPath));
  const server = http.createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    const file = await responseFile(root, request.url ?? "/");
    if (!file) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
      return;
    }
    const stat = await fsp.stat(file);
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      "Content-Length": stat.size,
      "Content-Type": CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    });
    if (request.method === "HEAD") response.end();
    else fs.createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function main(): Promise<void> {
  const root = option("--root");
  const host = option("--host") ?? "127.0.0.1";
  const port = Number(option("--port"));
  if (!root || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Usage: static-server --root <directory> --host <host> --port <port>");
  }
  const server = await startStaticServer(root, host, port);
  const stop = (): void => {
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

const invokedFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedFile === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
