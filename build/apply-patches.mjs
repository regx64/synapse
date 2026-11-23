#!/usr/bin/env node
// Applies patches/series.json to ./vscode in order. Stops at the first patch that fails and names it.
//   node build/apply-patches.mjs [--check]
import * as path from "node:path";
import { ROOT, VSCODE, capture, fail, readJson } from "./lib.mjs";

const check = process.argv.includes("--check");
const series = readJson(path.join(ROOT, "patches", "series.json"));
let applied = 0;
for (const p of series.patches) {
  const file = path.join(ROOT, "patches", p.file);
  const r = capture("git", ["apply", "--ignore-whitespace", "--3way", ...(check ? ["--check"] : []), file], { cwd: VSCODE });
  if (r.code !== 0) {
    fail(`patch ${p.file} (owner ${p.owner}) does not apply to this upstream:\n${r.stderr}\nReason it exists: ${p.reason}`);
  }
  applied++;
  console.log(`${check ? "checked" : "applied"} ${p.file}`);
}
console.log(`${applied} of ${series.budget} budgeted core patches ${check ? "apply cleanly" : "applied"}`);
