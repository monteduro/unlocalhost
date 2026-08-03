import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startStaticServer } from "../src/static-server.js";

test("the built-in static server exposes only its document root", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "unlocalhost-static-"));
  const root = path.join(project, "public");
  await fs.mkdir(root);
  await fs.writeFile(path.join(project, "secret.txt"), "private");
  await fs.writeFile(path.join(root, "index.html"), "<h1>Public website</h1>");
  await fs.writeFile(path.join(root, "app.js"), "console.log('public')");

  const server = await startStaticServer(root, "127.0.0.1", 0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const homepage = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(homepage.status, 200);
    assert.equal(await homepage.text(), "<h1>Public website</h1>");
    assert.match(homepage.headers.get("content-type") ?? "", /text\/html/);

    const javascript = await fetch(`http://127.0.0.1:${address.port}/app.js`);
    assert.equal(javascript.status, 200);
    assert.match(javascript.headers.get("content-type") ?? "", /text\/javascript/);

    const outside = await fetch(`http://127.0.0.1:${address.port}/..%2Fsecret.txt`);
    assert.equal(outside.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
});
