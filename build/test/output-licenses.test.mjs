import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "check-output-licenses.mjs");
const write = (f, s) => (fs.mkdirSync(path.dirname(f), { recursive: true }), fs.writeFileSync(f, s));

function fixture({ withLicense, withNotices = true }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-out-"));
  const out = path.join(root, "VSCode-linux-x64");
  const app = path.join(out, "resources", "app");
  write(path.join(app, "package.json"), "{}");
  if (withNotices) {
    write(path.join(app, "ThirdPartyNotices.txt"), "notices");
    write(path.join(app, "extensions", "synapse-collab", "dist", "ThirdPartyNotices.txt"), "ours");
  }
  const cli = path.join(app, "extensions", "copilot", "node_modules", "@github", "copilot");
  write(path.join(cli, "package.json"), JSON.stringify({ name: "@github/copilot", version: "1.0.73", license: "SEE LICENSE IN LICENSE.md" }));
  if (withLicense) write(path.join(cli, "LICENSE.md"), "GitHub Copilot CLI License");
  write(path.join(app, "node_modules", "mit-thing", "package.json"), JSON.stringify({ name: "mit-thing", version: "1.0.0", license: "MIT" }));
  // A Code - OSS checkout outside any repository, with the license, for --fix.
  const checkout = path.join(root, "synapse-vscode");
  const src = path.join(checkout, "node_modules", ".pnpm", "@github+copilot@1.0.73", "node_modules", "@github", "copilot");
  write(path.join(src, "package.json"), JSON.stringify({ name: "@github/copilot", version: "1.0.73", license: "SEE LICENSE IN LICENSE.md" }));
  write(path.join(src, "LICENSE.md"), "GitHub Copilot CLI License");
  return { out, cli, checkout };
}

const run = (out, checkout, ...flags) =>
  spawnSync(process.execPath, [script, out, ...flags], { encoding: "utf8", env: { ...process.env, SYNAPSE_VSCODE_DIR: checkout } });

test("passes when custom-licensed packages ship their license file", () => {
  const f = fixture({ withLicense: true });
  const r = run(f.out, f.checkout);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ok\s+@github\/copilot@1\.0\.73/);
});

test("fails when a custom license file is missing, and --fix copies it from the checkout", () => {
  const f = fixture({ withLicense: false });
  const bad = run(f.out, f.checkout);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /@github\/copilot@1\.0\.73 .* LICENSE\.md is not in the app/);
  const fixed = run(f.out, f.checkout, "--fix");
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.equal(fs.readFileSync(path.join(f.cli, "LICENSE.md"), "utf8"), "GitHub Copilot CLI License");
});

test("fails when third-party notices are missing", () => {
  const f = fixture({ withLicense: true, withNotices: false });
  const r = run(f.out, f.checkout);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ThirdPartyNotices/);
});
