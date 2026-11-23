/** Test fixtures shared by synapse packages. Not part of the runtime API. */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function makeRepo(files: Record<string, string>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "synapse-test-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  for (const [p, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), content);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
  return dir;
}

export function write(root: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

export function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export async function waitFor<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 15000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The shop fixture used by the signature-change scenario. */
export const SHOP = {
  "src/pricing.ts": `export function applyDiscount(total: number, percent: number): number {
  return total - (total * percent) / 100;
}

export function formatPrice(value: number): string {
  return "$" + value.toFixed(2);
}
`,
  "src/cart.ts": `import { applyDiscount, formatPrice } from "./pricing";

export class Cart {
  items: number[] = [];

  add(price: number): void {
    this.items.push(price);
  }

  total(): number {
    return this.items.reduce((a, b) => a + b, 0);
  }

  summary(percent: number): string {
    return formatPrice(applyDiscount(this.total(), percent));
  }
}
`,
  "package.json": `{ "name": "shop", "private": true }\n`,
};
