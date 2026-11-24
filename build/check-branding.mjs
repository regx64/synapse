#!/usr/bin/env node
// Branding and notice checklist, run every release (risk L4).
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, VSCODE, fail, readJson } from "./lib.mjs";

const problems = [];
const product = readJson(path.join(ROOT, "product.json"));
const forbidden = /visual studio code|vs ?code|\bvscode\b|microsoft/i;
const identityKeys = ["nameShort", "nameLong", "applicationName", "dataFolderName", "win32DirName", "win32NameVersion", "win32AppUserModelId", "darwinBundleIdentifier", "linuxDesktopName", "urlProtocol", "companyName", "copyright", "publisherUrl"];
for (const k of identityKeys) {
  if (!product[k]) problems.push(`product.json is missing ${k}`);
  else if (forbidden.test(String(product[k]))) problems.push(`product.json ${k} uses a Microsoft name: ${product[k]}`);
}
if (product.enableTelemetry !== false) problems.push("product.json must set enableTelemetry to false (Synapse collects no data)");
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
  // Synapse collects no data: none of upstream's collection endpoints may ship.
  // (telemetry and experiments, crash uploads, surveys, AI-backed settings search, settings sync)
  if (shipped.enableTelemetry !== false) problems.push("vscode/product.json: enableTelemetry must be false");
  for (const k of ["aiConfig", "tasConfig", "appCenter", "crashReporter", "surveys", "npsSurveyUrl", "cesSurveyUrl", "configurationSync.store", "editSessions.store", "telemetryEndpoint"]) {
    if (k in shipped) problems.push(`vscode/product.json must not set ${k} (data collection)`);
  }
  for (const f of ["LICENSE.txt", "ThirdPartyNotices.txt"]) if (!fs.existsSync(path.join(VSCODE, f))) problems.push(`vscode/${f} is missing: upstream notices must ship`);
  // Every upstream icon must have been replaced with Synapse's.
  const overlay = readJson(path.join(ROOT, "resources", "generated", "overlay.json"));
  for (const [upstreamPath, generated] of Object.entries(overlay)) {
    const a = fs.readFileSync(path.join(VSCODE, upstreamPath));
    const b = fs.readFileSync(path.join(ROOT, "resources", "generated", generated));
    if (!a.equals(b)) problems.push(`vscode/${upstreamPath} is still upstream's icon`);
  }
  if (!fs.existsSync(path.join(VSCODE, "extensions", "synapse-collab", "dist", "ThirdPartyNotices.txt"))) {
    problems.push("vscode/extensions/synapse-collab/dist/ThirdPartyNotices.txt is missing: the extension's bundled dependencies need their notices");
  }
  const manifest = fs.readFileSync(path.join(VSCODE, "resources", "win32", "VisualElementsManifest.xml"), "utf8");
  if (/Code - OSS|Visual Studio Code/.test(manifest)) problems.push("the Windows tile manifest still shows the upstream name");
}

// The icon sources and their generated files must be in the repository.
if (!fs.existsSync(path.join(ROOT, "resources", "icons", "mark.svg"))) problems.push("resources/icons/mark.svg is missing");
const overlayFile = path.join(ROOT, "resources", "generated", "overlay.json");
if (!fs.existsSync(overlayFile)) problems.push("resources/generated is missing: run node build/icons.mjs");
else {
  const required = ["resources/darwin/code.icns", "resources/win32/code.ico", "resources/linux/code.png", "src/vs/workbench/browser/media/code-icon.svg"];
  const overlay = readJson(overlayFile);
  for (const r of required) if (!overlay[r]) problems.push(`no Synapse replacement for upstream ${r}`);
  for (const g of Object.values(overlay)) if (!fs.existsSync(path.join(ROOT, "resources", "generated", g))) problems.push(`resources/generated/${g} is missing: run node build/icons.mjs`);
}

if (problems.length) fail(problems.join("\n"));
console.log("branding and notices: ok");
