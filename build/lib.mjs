// Shared helpers for the fork build scripts. Node only, so they run on Linux, macOS and Windows CI.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const VSCODE = process.env.SYNAPSE_VSCODE_DIR ? path.resolve(process.env.SYNAPSE_VSCODE_DIR) : path.join(ROOT, "vscode");
export const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
export const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, "\t") + "\n");
export const upstream = () => readJson(path.join(ROOT, "build", "upstream.json"));

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with exit code ${r.status}`);
  }
  return r;
}

export function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32", ...opts });
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

export function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}
