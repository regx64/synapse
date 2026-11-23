import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createUpdateServer } from "../update-server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("update feed and server speak the Code - OSS update protocol", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-update-"));
  const assets = path.join(dir, "assets");
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(assets, "Synapse-darwin-arm64-0.2.0.zip"), "zip bytes");
  fs.writeFileSync(path.join(assets, "SynapseUserSetup-x64-0.2.0.exe"), "exe bytes");
  const feed = path.join(dir, "feed");
  execFileSync(process.execPath, [path.join(here, "..", "update-feed.mjs"), "--version", "0.2.0", "--commit", "abc123", "--assets", assets, "--base-url", "https://example.com/dl", "--out", feed]);
  assert.deepEqual(fs.readdirSync(path.join(feed, "stable")).sort(), ["darwin-arm64.json", "win32-x64-user.json"]);

  const server = createUpdateServer(feed);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const newer = await fetch(`${base}/api/update/darwin-arm64/stable/old999`);
    assert.equal(newer.status, 200);
    const body = await newer.json();
    assert.equal(body.url, "https://example.com/dl/Synapse-darwin-arm64-0.2.0.zip");
    assert.equal(body.productVersion, "0.2.0");
    assert.match(body.sha256hash, /^[0-9a-f]{64}$/);
    assert.equal((await fetch(`${base}/api/update/darwin-arm64/stable/abc123`)).status, 204);
    assert.equal((await fetch(`${base}/api/update/linux-x64/stable/old999`)).status, 404);
    assert.equal((await fetch(`${base}/api/update/..%2F..%2Fetc/stable/x`)).status, 400);
  } finally {
    server.close();
  }
});
