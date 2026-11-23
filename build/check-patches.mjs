#!/usr/bin/env node
// Enforces the core patch budget (risk T2): at most `budget` patches, each registered with an owner and a reason.
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, fail, readJson } from "./lib.mjs";

const dir = path.join(ROOT, "patches");
const series = readJson(path.join(dir, "series.json"));
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".patch"));
const registered = new Set(series.patches.map((p) => p.file));
const problems = [];

for (const f of files) if (!registered.has(f)) problems.push(`${f} is not registered in patches/series.json`);
for (const p of series.patches) {
  if (!files.includes(p.file)) problems.push(`${p.file} is registered but missing`);
  if (!p.owner) problems.push(`${p.file} has no owner`);
  if (!p.reason || p.reason.length < 15) problems.push(`${p.file} needs a reason (why the extension API cannot do this)`);
}
if (series.patches.length > series.budget) {
  problems.push(`${series.patches.length} core patches exceed the budget of ${series.budget}. This is a G3 signal: see docs/plan.md, "Gates".`);
}
if (problems.length) fail(problems.join("\n"));
const warnAt = Math.ceil(series.budget * 0.75);
console.log(`core patches: ${series.patches.length}/${series.budget}${series.patches.length >= warnAt ? " (close to budget: review at the next gate)" : ""}`);
