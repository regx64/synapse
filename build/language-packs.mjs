#!/usr/bin/env node
// Language packs built into Synapse (build/language-packs.json).
//
//   node build/language-packs.mjs --prepare
//     Downloads each pinned pack (checking its sha256) and puts it in the
//     upstream checkout's extensions/, so the build ships it like any
//     built-in extension. Its icon (a product logo) is left out, and its MIT
//     license is added.
//
//   node build/language-packs.mjs --index <VSCode-platform-arch>
//     Writes out/synapse-languagepacks.json in a built app: which languages
//     ship and where their translations are. Patch 0004 reads it, so the
//     editor uses a built-in pack without anyone installing it.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ROOT, VSCODE, fail, findAppRoot, readJson } from "./lib.mjs";

const { packs } = readJson(path.join(ROOT, "build", "language-packs.json"));
const folderOf = (p) => p.id.split(".").slice(1).join(".");

if (process.argv.includes("--prepare")) {
  const cache = path.join(os.tmpdir(), "synapse-language-packs");
  fs.mkdirSync(cache, { recursive: true });
  for (const p of packs) {
    const vsix = path.join(cache, `${p.id}-${p.version}.vsix`);
    if (!fs.existsSync(vsix) || sha256(vsix) !== p.sha256) {
      const res = await fetch(p.url);
      if (!res.ok) fail(`could not download ${p.id} ${p.version}: HTTP ${res.status}`);
      fs.writeFileSync(vsix, Buffer.from(await res.arrayBuffer()));
    }
    const got = sha256(vsix);
    if (got !== p.sha256) fail(`${p.id} ${p.version}: sha256 ${got}, expected ${p.sha256}`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-lp-"));
    unzip(vsix, tmp);
    const dst = path.join(VSCODE, "extensions", folderOf(p));
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(path.join(tmp, "extension"), dst, { recursive: true });
    const manifestFile = path.join(dst, "package.json");
    const manifest = readJson(manifestFile);
    if (manifest.icon) fs.rmSync(path.join(dst, manifest.icon), { force: true });
    // Its readme and changelog describe the pack for VS Code; the Extensions view would show them.
    for (const f of ["readme.md", "README.md", "changelog.md", "CHANGELOG.md"]) fs.rmSync(path.join(dst, f), { force: true });
    delete manifest.icon;
    delete manifest.scripts;
    manifest.license = "MIT";
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
    fs.copyFileSync(path.join(ROOT, "build", "licenses", "vscode-loc-LICENSE.md"), path.join(dst, "LICENSE.md"));
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`language pack: ${p.language} (${p.id} ${p.version}) in extensions/${folderOf(p)}`);
  }
} else if (process.argv.includes("--index")) {
  const dir = process.argv[process.argv.indexOf("--index") + 1];
  const appRoot = dir && findAppRoot(path.resolve(dir));
  if (!appRoot) fail("usage: node build/language-packs.mjs --index <built app folder>");
  const out = path.join(appRoot, "out");
  const index = {};
  for (const p of packs) {
    const extDir = path.join(appRoot, "extensions", folderOf(p));
    const manifestFile = path.join(extDir, "package.json");
    if (!fs.existsSync(manifestFile)) fail(`${p.id} is not in the built app (extensions/${folderOf(p)})`);
    const manifest = readJson(manifestFile);
    const loc = (manifest.contributes?.localizations ?? []).find((l) => l.languageId === p.language);
    if (!loc) fail(`${p.id} has no "${p.language}" localization`);
    const translations = {};
    for (const tr of loc.translations) {
      const file = path.join(extDir, tr.path);
      if (fs.existsSync(file)) translations[tr.id] = path.relative(out, file).split(path.sep).join("/");
    }
    if (!translations.vscode) fail(`${p.id}: no translation of the editor itself`);
    index[p.language] = {
      hash: createHash("md5").update(`${p.id.toLowerCase()}@${manifest.version}`).digest("hex"),
      label: loc.localizedLanguageName ?? loc.languageName,
      extensions: [{ extensionIdentifier: { id: p.id.toLowerCase() }, version: manifest.version }],
      translations,
    };
  }
  fs.writeFileSync(path.join(out, "synapse-languagepacks.json"), JSON.stringify(index, null, "\t") + "\n");
  console.log(`language packs: ${Object.keys(index).join(", ")} indexed in out/synapse-languagepacks.json`);
} else {
  fail("usage: node build/language-packs.mjs --prepare | --index <built app folder>");
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Unzips with the OS's own tool (a .vsix is a zip). */
function unzip(zip, dest) {
  if (process.platform === "win32") {
    // Expand-Archive only takes .zip names.
    const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "synapse-zip-")), "pack.zip");
    fs.copyFileSync(zip, copy);
    execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${copy}' -DestinationPath '${dest}' -Force`], { stdio: "inherit" });
  } else {
    execFileSync("unzip", ["-q", "-o", zip, "-d", dest], { stdio: "inherit" });
  }
}
