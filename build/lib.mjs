// Shared helpers for the fork build scripts. Node only, so they run on Linux, macOS and Windows CI.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The Code - OSS checkout lives OUTSIDE this repository (default: a sibling
// folder). Inside it, TypeScript would pick up this repository's
// node_modules/@types (for example @types/vscode) while compiling VS Code
// and fail with duplicate declarations.
export const VSCODE = process.env.SYNAPSE_VSCODE_DIR ? path.resolve(process.env.SYNAPSE_VSCODE_DIR) : path.join(path.dirname(ROOT), "synapse-vscode");
{
  const rel = path.relative(ROOT, VSCODE);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    console.error(`error: the Code - OSS checkout (${VSCODE}) must be outside the Synapse repository; set SYNAPSE_VSCODE_DIR to another folder.`);
    process.exit(1);
  }
}
/** Where the upstream build writes the app: next to the Code - OSS checkout. */
export const buildOutput = (platform, arch) => path.join(path.dirname(VSCODE), `VSCode-${platform}-${arch}`);
/** The built app's resources/app folder (macOS: <Name>.app/Contents/Resources/app; Windows: may sit in a versioned folder). */
export function findAppRoot(dir, depth = 0) {
  if (depth > 6) return undefined;
  if (path.basename(dir) === "app" && path.basename(path.dirname(dir)).toLowerCase() === "resources" && fs.existsSync(path.join(dir, "package.json"))) return dir;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.isSymbolicLink() || e.name === "node_modules") continue;
    const found = findAppRoot(path.join(dir, e.name), depth + 1);
    if (found) return found;
  }
  return undefined;
}

export const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
export const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, "\t") + "\n");
export const upstream = () => readJson(path.join(ROOT, "build", "upstream.json"));

// On Windows, package-manager launchers are .cmd shims that only start through
// a shell. Everything else (git, node) runs directly, so arguments with spaces
// stay intact; through the shell they are quoted.
const SHIMS = /^(npm|npx|pnpm|corepack|yarn)$/;
export function spawnArgs(cmd, args, platform = process.platform) {
  const shell = platform === "win32" && SHIMS.test(cmd);
  return { args: shell ? args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)) : args, shell };
}

export function run(cmd, args, opts = {}) {
  const s = spawnArgs(cmd, args);
  const r = spawnSync(cmd, s.args, { stdio: "inherit", shell: s.shell, ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with exit code ${r.status}`);
  }
  return r;
}

export function capture(cmd, args, opts = {}) {
  const s = spawnArgs(cmd, args);
  const r = spawnSync(cmd, s.args, { encoding: "utf8", shell: s.shell, ...opts });
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

export function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}
