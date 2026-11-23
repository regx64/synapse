import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnArgs } from "../lib.mjs";

test("Windows: git runs without a shell so arguments with spaces stay whole", () => {
  assert.deepEqual(spawnArgs("git", ["commit", "-m", "Synapse 0.1.0"], "win32"), { args: ["commit", "-m", "Synapse 0.1.0"], shell: false });
});

test("Windows: package-manager shims run through the shell with quoted arguments", () => {
  assert.deepEqual(spawnArgs("pnpm", ["run", "gulp", "vscode-win32-x64-min"], "win32"), { args: ["run", "gulp", "vscode-win32-x64-min"], shell: true });
  assert.deepEqual(spawnArgs("npm", ["run", "a b", 'say "hi"'], "win32").args, ['run', '"a b"', '"say ""hi"""']);
});

test("Elsewhere: never a shell", () => {
  assert.deepEqual(spawnArgs("pnpm", ["install"], "linux"), { args: ["install"], shell: false });
});
