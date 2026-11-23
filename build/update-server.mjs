#!/usr/bin/env node
// A minimal auto-update server implementing the protocol Code - OSS clients
// speak, so updates need no core patch (phase 4):
//
//   GET /api/update/<platform>/<quality>/<commit>
//     204           the client's commit is the latest
//     200 + JSON    the latest release for that platform (see update-feed.mjs)
//     404           no release for that platform/quality
//
// Point product.json "updateUrl" at wherever this runs. No dependencies.
//   node build/update-server.mjs --feed update-feed --port 8080
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SAFE = /^[a-z0-9-]+$/;

export function createUpdateServer(feedDir) {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET") return send(res, 405);
    if (url.pathname === "/healthz") return send(res, 200, { ok: true });
    const m = /^\/api\/update\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (!m) return send(res, 404);
    const [, platform, quality, commit] = m;
    if (!SAFE.test(platform) || !SAFE.test(quality)) return send(res, 400);
    let latest;
    try {
      latest = JSON.parse(fs.readFileSync(path.join(feedDir, quality, `${platform}.json`), "utf8"));
    } catch {
      return send(res, 404);
    }
    if (latest.version === commit) return send(res, 204);
    return send(res, 200, latest);
  });
}

function send(res, status, body) {
  res.writeHead(status, body ? { "content-type": "application/json", "cache-control": "no-cache" } : {});
  res.end(body ? JSON.stringify(body) : undefined);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { feed: { type: "string", default: "update-feed" }, port: { type: "string", default: "8080" } } });
  createUpdateServer(path.resolve(values.feed)).listen(Number(values.port), () => console.log(`update server on :${values.port}, feed ${values.feed}`));
}
