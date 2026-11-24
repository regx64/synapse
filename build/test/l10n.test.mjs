import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { ROOT } from "../lib.mjs";

const ext = path.join(ROOT, "extensions", "synapse-collab");
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test("every extension message has a Korean translation", () => {
  const used = new Set();
  for (const f of walk(path.join(ext, "src")).filter((f) => f.endsWith(".ts"))) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(/\bl\(\s*"((?:[^"\\]|\\.)*)"/g)) used.add(JSON.parse(`"${m[1]}"`));
  }
  const ko = JSON.parse(fs.readFileSync(path.join(ext, "l10n", "bundle.l10n.ko.json"), "utf8"));
  assert.deepEqual([...used].filter((s) => !(s in ko)), [], "missing in l10n/bundle.l10n.ko.json");
});

test("webview strings exist in English and Korean alike", () => {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ext, "media", "ui", "strings.js"), "utf8"), sandbox);
  const { en, ko } = sandbox.window.SYNAPSE_STRINGS;
  assert.deepEqual(Object.keys(en).filter((k) => !(k in ko)), [], "missing in Korean");
  assert.deepEqual(Object.keys(ko).filter((k) => !(k in en)), [], "missing in English");
  // Every literal t("key") in the views is defined.
  const used = new Set();
  for (const f of walk(path.join(ext, "media", "ui")).filter((f) => f.endsWith(".js") && !f.endsWith("strings.js"))) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(/\bt\("([a-zA-Z0-9.-]+)"/g)) used.add(m[1]);
  }
  assert.deepEqual([...used].filter((k) => !(k in en)), [], "used but not defined");
});

test("manifest strings exist in English and Korean alike", () => {
  const en = JSON.parse(fs.readFileSync(path.join(ext, "package.nls.json"), "utf8"));
  const ko = JSON.parse(fs.readFileSync(path.join(ext, "package.nls.ko.json"), "utf8"));
  assert.deepEqual(Object.keys(en).filter((k) => !(k in ko)), []);
  const manifest = fs.readFileSync(path.join(ext, "package.json"), "utf8");
  const refs = [...manifest.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]);
  assert.deepEqual(refs.filter((k) => !(k in en)), [], "package.json refers to missing strings");
});
