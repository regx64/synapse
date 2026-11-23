#!/usr/bin/env node
// Full development build: fetch upstream, apply patches, prepare, compile.
//   node build/build.mjs [--platform linux|darwin|win32] [--arch x64|arm64] [--skip-fetch]
// Needs Node and pnpm versions from build/upstream.json (corepack provides pnpm).
// Release signing, notarization and auto-update come in phase 4.
import * as os from "node:os";
import { ROOT, VSCODE, buildOutput, run, upstream } from "./lib.mjs";

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

run("corepack", ["enable"], { cwd: VSCODE });
run("pnpm", ["install", "--frozen-lockfile"], { cwd: VSCODE, env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: "" } });
const target = platform === "darwin" ? `vscode-darwin-${arch}-min` : platform === "win32" ? `vscode-win32-${arch}-min` : `vscode-linux-${arch}-min`;
run("pnpm", ["run", "gulp", target], { cwd: VSCODE });
console.log(`built ${target}: ${buildOutput(platform, arch)}`);
