#!/usr/bin/env node
// Turns a patched Code - OSS checkout into Synapse: merges product.json, and
// adds the built-in extension (with its bundled synapse-core).
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, VSCODE, fail, readJson, writeJson } from "./lib.mjs";

if (!fs.existsSync(path.join(VSCODE, "product.json"))) fail("vscode/ is missing: run node build/get-vscode.mjs first");

// 1. product.json
const productPath = path.join(VSCODE, "product.json");
const product = readJson(productPath);
const overrides = readJson(path.join(ROOT, "product.json"));
for (const key of overrides.$remove ?? []) delete product[key];
for (const [key, value] of Object.entries(overrides)) {
  if (!key.startsWith("$")) product[key] = value;
}
product.synapseVersion = readJson(path.join(ROOT, "package.json")).version;
writeJson(productPath, product);
console.log(`product.json: ${product.nameLong} ${product.synapseVersion} on Code - OSS ${readJson(path.join(VSCODE, "package.json")).version}`);

// 2. Built-in extension. Code - OSS packages every extensions/*/package.json;
//    ours ships prebuilt (dist/), so the upstream build only copies it.
const extSrc = path.join(ROOT, "extensions", "synapse-collab");
const extDst = path.join(VSCODE, "extensions", "synapse-collab");
if (!fs.existsSync(path.join(extSrc, "dist", "extension.cjs")) || !fs.existsSync(path.join(extSrc, "dist", "core", "main.mjs"))) {
  fail("extensions/synapse-collab is not built: run npm ci && npm run build first");
}
fs.rmSync(extDst, { recursive: true, force: true });
fs.mkdirSync(extDst, { recursive: true });
for (const entry of ["dist", "media", ".vscodeignore", "README.md"]) {
  const from = path.join(extSrc, entry);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(extDst, entry), { recursive: true, filter: (f) => !f.endsWith(".map") });
}
fs.copyFileSync(path.join(ROOT, "LICENSE"), path.join(extDst, "LICENSE"));
const manifest = readJson(path.join(extSrc, "package.json"));
delete manifest.devDependencies;
delete manifest.scripts;
delete manifest.private;
writeJson(path.join(extDst, "package.json"), manifest);
console.log(`built-in extension: extensions/synapse-collab (${manifest.version})`);

// 3. License notices (L4): keep upstream's MIT notice and third-party notices; add ours alongside.
for (const f of ["LICENSE.txt", "ThirdPartyNotices.txt"]) {
  if (!fs.existsSync(path.join(VSCODE, f))) fail(`upstream ${f} is missing; refusing to build without license notices`);
}
fs.copyFileSync(path.join(ROOT, "LICENSE"), path.join(VSCODE, "SYNAPSE-LICENSE.txt"));
console.log("prepared vscode/ for a Synapse build");
