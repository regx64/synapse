#!/usr/bin/env node
// Writes the auto-update feed for a release (phase 4): one JSON file per
// platform, read by build/update-server.mjs.
//
//   node build/update-feed.mjs --version 0.2.0 --commit <vscode commit> --quality stable \
//     --assets dist/release --base-url https://github.com/<owner>/synapse/releases/download/v0.2.0 --out update-feed
//
// Asset names (from the release workflow):
//   Synapse-darwin-arm64-<v>.zip, Synapse-darwin-x64-<v>.zip,
//   SynapseUserSetup-x64-<v>.exe, SynapseSetup-x64-<v>.exe, Synapse-win32-x64-<v>.zip,
//   synapse-linux-x64-<v>.tar.gz
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({
  options: {
    version: { type: "string" },
    commit: { type: "string" },
    quality: { type: "string", default: "stable" },
    assets: { type: "string" },
    "base-url": { type: "string" },
    out: { type: "string", default: "update-feed" },
  },
});
for (const k of ["version", "commit", "assets", "base-url"]) if (!a[k]) throw new Error(`--${k} is required`);

// VS Code platform ids → asset name patterns.
const PLATFORMS = {
  "darwin-arm64": /^Synapse-darwin-arm64-.*\.zip$/,
  darwin: /^Synapse-darwin-x64-.*\.zip$/,
  "win32-x64-user": /^SynapseUserSetup-x64-.*\.exe$/,
  "win32-x64": /^SynapseSetup-x64-.*\.exe$/,
  "win32-x64-archive": /^Synapse-win32-x64-.*\.zip$/,
  "linux-x64": /^synapse-linux-x64-.*\.tar\.gz$/,
};

const files = fs.readdirSync(a.assets);
const outDir = path.join(a.out, a.quality);
fs.mkdirSync(outDir, { recursive: true });
let written = 0;
for (const [platform, re] of Object.entries(PLATFORMS)) {
  const name = files.find((f) => re.test(f));
  if (!name) continue;
  const buf = fs.readFileSync(path.join(a.assets, name));
  const entry = {
    url: `${a["base-url"].replace(/\/$/, "")}/${name}`,
    name: a.version,
    version: a.commit,
    productVersion: a.version,
    hash: createHash("sha1").update(buf).digest("hex"),
    sha256hash: createHash("sha256").update(buf).digest("hex"),
    timestamp: Date.now(),
    supportsFastUpdate: platform.startsWith("win32") && !platform.endsWith("archive"),
  };
  fs.writeFileSync(path.join(outDir, `${platform}.json`), JSON.stringify(entry, null, 2) + "\n");
  written++;
  console.log(`${a.quality}/${platform}.json → ${name}`);
}
if (!written) throw new Error(`no release assets matched in ${a.assets}`);
