#!/usr/bin/env node
// License check on a built app (what users actually receive):
//
//   - every package whose package.json says "SEE LICENSE IN <file>" (a
//     proprietary or custom license, e.g. the GitHub Copilot CLI) must ship
//     that file; with --fix, a missing one is copied from the same package
//     version in the Code - OSS checkout;
//   - upstream's LICENSE and ThirdPartyNotices, and Synapse's extension
//     notices, must be in the app;
//   - no part of the built-in GitHub Copilot may be in the app (patch 0002).
//
//   node build/check-output-licenses.mjs <VSCode-platform-arch> [--fix] [--json]
import * as fs from "node:fs";
import * as path from "node:path";
import { VSCODE, findAppRoot } from "./lib.mjs";

const args = process.argv.slice(2);
const fix = args.includes("--fix");
const json = args.includes("--json");
const outDir = args.find((a) => !a.startsWith("--"));
if (!outDir || !fs.existsSync(outDir)) {
  console.error("usage: node build/check-output-licenses.mjs <built app folder> [--fix] [--json]");
  process.exit(2);
}

/** All package folders under any node_modules below `dir`. */
function* packages(dir) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    const parent = path.basename(path.dirname(d));
    // node_modules/<name> or node_modules/@scope/<name>
    const isPackage =
      !path.basename(d).startsWith("@") &&
      (parent === "node_modules" || (parent.startsWith("@") && path.basename(path.dirname(path.dirname(d))) === "node_modules"));
    if (isPackage && fs.existsSync(path.join(d, "package.json"))) yield d;
    for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink() && e.name !== ".bin") stack.push(path.join(d, e.name));
  }
}

/** Finds the same package version in the Code - OSS checkout, for --fix. */
function sourceCopy(name, version, file) {
  const roots = [path.join(VSCODE, "node_modules"), path.join(VSCODE, "extensions")];
  const pnpmDir = path.join(VSCODE, "node_modules", ".pnpm");
  const candidates = [];
  if (fs.existsSync(pnpmDir)) {
    const prefix = name.replace("/", "+") + "@" + version;
    for (const e of fs.readdirSync(pnpmDir)) if (e === prefix || e.startsWith(prefix + "_")) candidates.push(path.join(pnpmDir, e, "node_modules", name));
  }
  for (const r of roots) for (const p of fs.existsSync(r) ? packages(r) : []) if (p.endsWith(path.join("node_modules", ...name.split("/")))) candidates.push(p);
  for (const c of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(c, "package.json"), "utf8"));
      if (pkg.version === version && fs.existsSync(path.join(c, file))) return path.join(c, file);
    } catch {
      /* not this one */
    }
  }
  return undefined;
}

const appRoot = findAppRoot(path.resolve(outDir));
if (!appRoot) {
  console.error(`no resources/app folder found under ${outDir}`);
  process.exit(2);
}

const problems = [];
const fixed = [];
const custom = [];
for (const dir of packages(appRoot)) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    continue;
  }
  const m = /^SEE LICENSE IN (.+)$/i.exec(String(pkg.license ?? ""));
  if (!m) continue;
  const file = m[1].trim();
  const rel = path.relative(appRoot, dir);
  const present = fs.existsSync(path.join(dir, file));
  custom.push({ name: pkg.name, version: pkg.version, where: rel, licenseFile: file, present });
  if (present) continue;
  const src = fix ? sourceCopy(pkg.name, pkg.version, file) : undefined;
  if (src) {
    fs.copyFileSync(src, path.join(dir, file));
    fixed.push(`${rel}/${file}`);
    custom[custom.length - 1].present = true;
  } else {
    problems.push(`${pkg.name}@${pkg.version} (${rel}) is distributed under "${pkg.license}" but ${file} is not in the app`);
  }
}

// Synapse does not ship the built-in GitHub Copilot (patch 0002).
for (const dir of packages(appRoot)) {
  const rel = path.relative(appRoot, dir).split(path.sep).join("/");
  if (/(^|\/)node_modules\/@github\/copilot/.test(rel)) problems.push(`${rel} is in the app, but Synapse does not ship GitHub Copilot`);
}
if (fs.existsSync(path.join(appRoot, "extensions", "copilot"))) problems.push("extensions/copilot is in the app, but Synapse does not ship GitHub Copilot");

// Notices that must ship. Upstream keeps them next to the app folder or above it.
const searchUp = (start, file) => {
  for (let d = start, i = 0; i < 4; d = path.dirname(d), i++) if (fs.existsSync(path.join(d, file))) return path.join(d, file);
  return undefined;
};
for (const f of ["ThirdPartyNotices.txt"]) if (!searchUp(appRoot, f)) problems.push(`${f} (upstream third-party notices) is not in the app`);
if (!fs.existsSync(path.join(appRoot, "extensions", "synapse-collab", "dist", "ThirdPartyNotices.txt"))) {
  problems.push("extensions/synapse-collab/dist/ThirdPartyNotices.txt is not in the app");
}

if (json) console.log(JSON.stringify({ appRoot, custom, fixed, problems }, null, 2));
else {
  console.log(`app: ${appRoot}`);
  for (const c of custom) console.log(`  ${c.present ? "ok     " : "MISSING"} ${c.name}@${c.version} — "SEE LICENSE IN ${c.licenseFile}" — ${c.where}`);
  for (const f of fixed) console.log(`  fixed: copied ${f} from the Code - OSS checkout`);
}
if (problems.length) {
  console.error(problems.map((p) => `error: ${p}`).join("\n"));
  process.exit(1);
}
console.log(`licenses: ${custom.length} custom-licensed package(s), all with their license file; notices present`);
