#!/usr/bin/env node
// Fetches the pinned upstream Code - OSS tag (shallow) into ../synapse-vscode, or
// SYNAPSE_VSCODE_DIR, and verifies its commit.
//   node build/get-vscode.mjs [--tag 1.148.0]   (a different tag is for sync rehearsals)
import * as fs from "node:fs";
import { VSCODE, capture, fail, run, upstream } from "./lib.mjs";

const pin = upstream();
const i = process.argv.indexOf("--tag");
const tag = i > 0 ? process.argv[i + 1] : pin.tag;

if (fs.existsSync(VSCODE)) {
  // Reuse the checkout when it has the tag: go back to it, dropping patches and the prepare commit.
  const want = tag === pin.tag ? pin.commit : capture("git", ["ls-remote", pin.repo, `refs/tags/${tag}`]).stdout.split(/\s+/)[0];
  const have = capture("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`], { cwd: VSCODE }).stdout;
  if (want && have === want) {
    console.log(`vscode/ has ${tag} (${have.slice(0, 10)}); resetting to it`);
    run("git", ["checkout", "-q", "--force", "--detach", have], { cwd: VSCODE });
    run("git", ["clean", "-fdq"], { cwd: VSCODE });
    process.exit(0);
  }
  console.log(`vscode/ does not have ${tag}; fetching it fresh`);
  fs.rmSync(VSCODE, { recursive: true, force: true });
}

// LF line endings on every OS, so patches/ (made with LF) apply the same way on
// Windows, where runners default to core.autocrlf=true. Files that need CRLF
// keep it through upstream's .gitattributes (eol=crlf).
run("git", ["-c", "advice.detachedHead=false", "clone", "--config", "core.autocrlf=false", "--config", "core.eol=lf", "--depth", "1", "--branch", tag, pin.repo, VSCODE]);
const head = capture("git", ["rev-parse", "HEAD"], { cwd: VSCODE }).stdout;
if (tag === pin.tag && head !== pin.commit) fail(`tag ${tag} resolved to ${head}, but build/upstream.json pins ${pin.commit}`);
console.log(`fetched Code - OSS ${tag} at ${head}`);
