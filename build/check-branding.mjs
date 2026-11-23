#!/usr/bin/env node
// Branding and notice checklist, run every release (risk L4).
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, VSCODE, fail, readJson } from "./lib.mjs";

const problems = [];
const product = readJson(path.join(ROOT, "product.json"));
const forbidden = /visual studio code|vs ?code|\bvscode\b|microsoft/i;
const identityKeys = ["nameShort", "nameLong", "applicationName", "dataFolderName", "win32DirName", "win32NameVersion", "win32AppUserModelId", "darwinBundleIdentifier", "linuxDesktopName", "urlProtocol"];
for (const k of identityKeys) {
  if (!product[k]) problems.push(`product.json is missing ${k}`);
  else if (forbidden.test(String(product[k]))) problems.push(`product.json ${k} uses a Microsoft name: ${product[k]}`);
}
if (product.enableTelemetry !== false) problems.push("product.json must set enableTelemetry to false (telemetry is opt-in, phase 4)");
if (!/open-vsx\.org/.test(product.extensionsGallery?.serviceUrl ?? "")) problems.push("extensionsGallery must point at Open VSX (Marketplace terms, risk L1)");
if (/marketplace\.visualstudio\.com/.test(JSON.stringify(product))) problems.push("product.json must not reference the Visual Studio Marketplace");
if (!fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8").startsWith("MIT License")) problems.push("LICENSE must be the MIT license");

// Icons: no Microsoft artwork in our resources.
const resDir = path.join(ROOT, "resources");
if (fs.existsSync(resDir)) {
  for (const f of fs.readdirSync(resDir, { recursive: true })) {
    if (/code[-_]?(oss|insiders)?\.(png|ico|icns|svg)$/i.test(String(f))) problems.push(`resources/${f} looks like an upstream icon`);
  }
}

// When a prepared upstream checkout is present, check what will actually ship.
if (fs.existsSync(path.join(VSCODE, "product.json"))) {
  const shipped = readJson(path.join(VSCODE, "product.json"));
  if (shipped.nameLong !== product.nameLong) problems.push("vscode/product.json is not prepared (run node build/prepare.mjs)");
  for (const f of ["LICENSE.txt", "ThirdPartyNotices.txt"]) if (!fs.existsSync(path.join(VSCODE, f))) problems.push(`vscode/${f} is missing: upstream notices must ship`);
}

if (problems.length) fail(problems.join("\n"));
console.log("branding and notices: ok");
