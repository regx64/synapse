#!/usr/bin/env node
// Fetches the pinned upstream Code - OSS tag into ./vscode (shallow) and verifies its commit.
//   node build/get-vscode.mjs [--tag 1.148.0]   (a different tag is for sync rehearsals)
import * as fs from "node:fs";
import { VSCODE, capture, fail, run, upstream } from "./lib.mjs";

const pin = upstream();
const i = process.argv.indexOf("--tag");
const tag = i > 0 ? process.argv[i + 1] : pin.tag;

if (fs.existsSync(VSCODE)) {
  const head = capture("git", ["rev-parse", "HEAD"], { cwd: VSCODE }).stdout;
  const want = capture("git", ["ls-remote", pin.repo, `refs/tags/${tag}`]).stdout.split(/\s+/)[0];
  if (head && head === want) {
    console.log(`vscode/ already at ${tag} (${head.slice(0, 10)}); resetting it to a clean tree`);
    run("git", ["reset", "--hard", "-q"], { cwd: VSCODE });
    run("git", ["clean", "-fdq"], { cwd: VSCODE });
    process.exit(0);
  }
  console.log(`vscode/ is at ${head.slice(0, 10)}, replacing it with ${tag}`);
  fs.rmSync(VSCODE, { recursive: true, force: true });
}

run("git", ["-c", "advice.detachedHead=false", "clone", "--depth", "1", "--branch", tag, pin.repo, VSCODE]);
const head = capture("git", ["rev-parse", "HEAD"], { cwd: VSCODE }).stdout;
if (tag === pin.tag && head !== pin.commit) fail(`tag ${tag} resolved to ${head}, but build/upstream.json pins ${pin.commit}`);
console.log(`fetched Code - OSS ${tag} at ${head}`);
