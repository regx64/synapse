#!/usr/bin/env node
// Full development build: fetch upstream, apply patches, prepare, compile.
//   node build/build.mjs [--platform linux|darwin|win32] [--arch x64|arm64] [--skip-fetch]
// Needs Node and pnpm versions from build/upstream.json (corepack provides pnpm).
// Release signing, notarization and auto-update come in phase 4.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ROOT, VSCODE, buildOutput, capture, run, upstream } from "./lib.mjs";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const platform = arg("platform", process.platform);
const arch = arg("arch", os.arch());
const pin = upstream();

const major = Number(process.versions.node.split(".")[0]);
const wantMajor = Number(pin.node.split(".")[0]);
if (major !== wantMajor) console.warn(`warning: Code - OSS ${pin.tag} expects Node ${pin.node}; this is ${process.version}`);

if (!process.argv.includes("--skip-fetch")) run(process.execPath, ["build/get-vscode.mjs"], { cwd: ROOT });
run(process.execPath, ["build/apply-patches.mjs"], { cwd: ROOT });
run(process.execPath, ["build/prepare.mjs"], { cwd: ROOT });

// Windows packaging strips signatures from bundled binaries with signtool.exe
// (Windows SDK). It is usually installed but not on PATH; find it.
const env = { ...process.env };
if (process.platform === "win32" && capture("where", ["signtool.exe"]).code !== 0) {
  const kits = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Windows Kits", "10", "bin");
  const versions = fs.existsSync(kits) ? fs.readdirSync(kits).filter((v) => /^10\./.test(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : [];
  const dir = versions.reverse().map((v) => path.join(kits, v, "x64")).find((d) => fs.existsSync(path.join(d, "signtool.exe")));
  if (!dir) throw new Error("signtool.exe not found: install the Windows 10/11 SDK (it is needed to package for Windows)");
  console.log(`using signtool from ${dir}`);
  // Windows environment names are case-insensitive; update the existing key only.
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "Path";
  env[key] = `${dir};${env[key] ?? ""}`;
}

run("corepack", ["enable"], { cwd: VSCODE });
run("pnpm", ["install", "--frozen-lockfile"], { cwd: VSCODE, env: { ...env, ELECTRON_SKIP_BINARY_DOWNLOAD: "" } });
const target = platform === "darwin" ? `vscode-darwin-${arch}-min` : platform === "win32" ? `vscode-win32-${arch}-min` : `vscode-linux-${arch}-min`;
run("pnpm", ["run", "gulp", target], { cwd: VSCODE, env });
// Upstream product names in the UI text become Synapse (no core patch needed).
run(process.execPath, ["build/rebrand.mjs", buildOutput(platform, arch)], { cwd: ROOT });
// What users receive must carry every license it needs, and no GitHub Copilot.
run(process.execPath, ["build/check-output-licenses.mjs", buildOutput(platform, arch), "--fix"], { cwd: ROOT });
console.log(`built ${target}: ${buildOutput(platform, arch)}`);
