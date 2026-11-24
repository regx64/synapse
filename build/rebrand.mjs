#!/usr/bin/env node
// Replaces "VS Code", "Visual Studio Code" and "Code - OSS" with the product
// name in the text users see in a built app, without patching upstream code:
//
//   - out/nls.messages.json (+ nls.messages.js): every UI message of the
//     workbench, read at startup;
//   - each built-in extension's package.nls.json, and the displayName and
//     description in its package.json (Extensions view, settings).
//
// Phrases that name Microsoft's real products are kept, so they stay true:
// "VS Code for the Web", the Stable/Insiders editions, the "VS Code
// marketplace". Built-in language packs' translations get the same treatment.
//
//   node build/rebrand.mjs <VSCode-platform-arch> [--name Synapse]
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, findAppRoot, readJson } from "./lib.mjs";

/** Phrases that refer to Microsoft's actual products and must not be renamed. */
const KEEP = [
  /VS Code for the Web/g,
  /\b(?:Stable|Insiders) (?:version of )?VS Code\b/g,
  /\bVS Code (?:Stable|Insiders)\b/g,
  /\bVS Code marketplace\b/gi,
  /\bVisual Studio Code Marketplace\b/gi,
  // The same in the Korean language pack.
  /(?:Visual Studio Code|VS ?Code)\s*마켓플레이스/g,
  /웹용 VS ?Code/g,
  /VS ?Code\s*(?:Insiders|참가자|안정)/g,
];
const NAME = /\bVisual Studio Code\b|\bVS ?Code\b|\bCode - OSS\b/g;

/** Returns `text` with upstream product names replaced by `name`, keeping the phrases in KEEP. */
export function rebrandText(text, name) {
  if (typeof text !== "string" || !NAME.test(text)) return text;
  NAME.lastIndex = 0;
  const kept = [];
  let masked = text;
  for (const re of KEEP) masked = masked.replace(re, (m) => `\u0000${kept.push(m) - 1}\u0000`);
  masked = masked.replace(NAME, name);
  return masked.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]);
}

/** Header and serialization of nls.messages.js, as upstream's build writes it (build/lib/nlsMessages.ts). */
const serialize = (data) => JSON.stringify(data).replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** Rebrands a built app in place. Returns counts for the build log. */
export function rebrandApp(appRoot, name) {
  const stats = { messages: 0, extensionStrings: 0 };
  const out = path.join(appRoot, "out");
  const messagesFile = path.join(out, "nls.messages.json");
  if (!fs.existsSync(messagesFile)) throw new Error(`${messagesFile} not found: not a built app?`);
  const messages = readJson(messagesFile);
  const rebranded = messages.map((m) => {
    const r = rebrandText(m, name);
    if (r !== m) stats.messages++;
    return r;
  });
  fs.writeFileSync(messagesFile, JSON.stringify(rebranded));
  const messagesJs = path.join(out, "nls.messages.js");
  if (fs.existsSync(messagesJs)) {
    const src = fs.readFileSync(messagesJs, "utf8");
    const at = src.indexOf("globalThis._VSCODE_NLS_MESSAGES=");
    if (at < 0) throw new Error(`${messagesJs}: unexpected format`);
    fs.writeFileSync(messagesJs, `${src.slice(0, at)}globalThis._VSCODE_NLS_MESSAGES=${serialize(rebranded)};`);
  }

  const extensions = path.join(appRoot, "extensions");
  for (const ext of fs.existsSync(extensions) ? fs.readdirSync(extensions, { withFileTypes: true }) : []) {
    if (!ext.isDirectory() || ext.name === "synapse-collab") continue;
    const nls = path.join(extensions, ext.name, "package.nls.json");
    if (fs.existsSync(nls)) {
      const data = readJson(nls);
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === "string") {
          const r = rebrandText(v, name);
          if (r !== v) (data[k] = r), stats.extensionStrings++;
        } else if (v && typeof v.message === "string") {
          const r = rebrandText(v.message, name);
          if (r !== v.message) (v.message = r), stats.extensionStrings++;
        }
      }
      fs.writeFileSync(nls, JSON.stringify(data, null, "\t"));
    }
    const manifest = path.join(extensions, ext.name, "package.json");
    if (fs.existsSync(manifest)) {
      const pkg = readJson(manifest);
      let changed = false;
      for (const k of ["displayName", "description"]) {
        const r = rebrandText(pkg[k], name);
        if (r !== pkg[k]) (pkg[k] = r), (changed = true), stats.extensionStrings++;
      }
      if (changed) fs.writeFileSync(manifest, JSON.stringify(pkg, null, "\t"));
      // Language packs built into the app: their translations name the product too.
      for (const loc of pkg.contributes?.localizations ?? []) {
        for (const tr of loc.translations ?? []) {
          const file = path.join(extensions, ext.name, tr.path);
          if (!fs.existsSync(file)) continue;
          const data = readJson(file);
          const n = rebrandDeep(data, name);
          if (n) fs.writeFileSync(file, JSON.stringify(data)), (stats.translations = (stats.translations ?? 0) + n);
        }
      }
    }
  }
  return stats;
}

/** Rebrands every string inside `obj` in place; returns how many changed. */
function rebrandDeep(obj, name) {
  let n = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      const r = rebrandText(v, name);
      if (r !== v) (obj[k] = r), n++;
    } else if (v && typeof v === "object") n += rebrandDeep(v, name);
  }
  return n;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const outDir = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--name");
  const nameIdx = args.indexOf("--name");
  const name = nameIdx >= 0 ? args[nameIdx + 1] : readJson(path.join(ROOT, "product.json")).nameShort;
  if (!outDir || !fs.existsSync(outDir)) {
    console.error("usage: node build/rebrand.mjs <built app folder> [--name <product name>]");
    process.exit(2);
  }
  const appRoot = findAppRoot(path.resolve(outDir));
  if (!appRoot) {
    console.error(`no resources/app folder found under ${outDir}`);
    process.exit(2);
  }
  const stats = rebrandApp(appRoot, name);
  console.log(`rebrand: "${name}" in ${stats.messages} UI messages, ${stats.extensionStrings} built-in extension strings and ${stats.translations ?? 0} translations`);
}
