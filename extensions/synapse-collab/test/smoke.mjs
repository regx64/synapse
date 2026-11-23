// Extension smoke test in a real VS Code (downloaded by @vscode/test-electron).
// Linux CI needs a display: xvfb-run -a node test/smoke.mjs
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "synapse-smoke-")));
const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
git("init", "-q", "-b", "main");
git("config", "user.email", "smoke@synapse.invalid");
git("config", "user.name", "smoke");
fs.mkdirSync(path.join(repo, "src"));
fs.writeFileSync(path.join(repo, "src", "pricing.ts"), "export function applyDiscount(total: number, percent: number): number {\n  return total - (total * percent) / 100;\n}\n");
git("add", "-A");
git("commit", "-q", "-m", "init");

try {
  await runTests({
    version: process.env.VSCODE_TEST_VERSION ?? "stable",
    extensionDevelopmentPath: path.resolve(here, ".."),
    extensionTestsPath: path.join(here, "suite.cjs"),
    launchArgs: [repo, "--disable-extensions", "--no-sandbox", "--disable-gpu", "--skip-welcome", "--skip-release-notes"],
    extensionTestsEnv: { SYNAPSE_SMOKE_REPO: repo },
  });
  console.log("smoke test passed");
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
}
