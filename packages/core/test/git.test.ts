import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { git, readBlobs, snapshotWorktree } from "../src/git.js";
import { SynapseCore } from "../src/index.js";
import { SHOP, gitOut, makeRepo, write } from "../src/testing.js";

test("a persistent snapshot index follows edits, reverts, new and deleted files, and commits", async () => {
  const repo = makeRepo(SHOP);
  const index = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "synapse-idx-")), "index");
  const head = gitOut(repo, "rev-parse", "HEAD");
  const snap = () => snapshotWorktree(repo, "snap", index);
  assert.equal(await snap(), head, "clean worktree: HEAD itself");

  write(repo, "src/pricing.ts", SHOP["src/pricing.ts"] + "\n// edit\n");
  const edited = await snap();
  assert.notEqual(edited, head);
  assert.equal(await snap(), edited, "deterministic: same content, same commit");

  write(repo, "src/new.ts", "export const n = 1;\n");
  const withNew = await snap();
  assert.match(await git(repo, ["show", "--name-only", "--format=", withNew]), /src\/new.ts/);

  fs.rmSync(path.join(repo, "src/new.ts"));
  write(repo, "src/pricing.ts", SHOP["src/pricing.ts"]);
  assert.equal(await snap(), head, "reverting everything gives HEAD again");

  // The agent commits: the index is rebuilt from the new HEAD.
  write(repo, "src/cart.ts", SHOP["src/cart.ts"] + "\n// committed\n");
  gitOut(repo, "commit", "-qam", "agent commit");
  const head2 = gitOut(repo, "rev-parse", "HEAD");
  assert.equal(await snap(), head2);
  fs.rmSync(path.join(repo, "src/cart.ts"));
  const deleted = await snap();
  assert.match(await git(repo, ["diff", "--name-status", head2, deleted]), /^D\tsrc\/cart.ts$/m);
});

test("readBlobs reads many blobs in one call, keeps multibyte text intact and skips missing ones", async () => {
  const repo = makeRepo({ "a.txt": "héllo — 世界\n", "b.txt": "plain\n" });
  const a = gitOut(repo, "rev-parse", "HEAD:a.txt");
  const b = gitOut(repo, "rev-parse", "HEAD:b.txt");
  const missing = "0123456789abcdef0123456789abcdef01234567";
  const r = await readBlobs(repo, [a, b, missing, a]);
  assert.equal(r.get(a), "héllo — 世界\n");
  assert.equal(r.get(b), "plain\n");
  assert.ok(!r.has(missing));
  assert.equal((await readBlobs(repo, [b])).get(b), "plain\n", "cached");
});

test("a refresh with no new changes keeps the agent's ownership as is", async () => {
  const repo = makeRepo(SHOP);
  const core = await SynapseCore.open({ workspace: repo, ephemeral: true });
  try {
    const a = await core.agents.add({ preset: "mock", id: "alpha" });
    write(a.worktree.path, "src/pricing.ts", SHOP["src/pricing.ts"].replace("/ 100;", "/ 100.0;"));
    write(a.worktree.path, "src/cart.ts", SHOP["src/cart.ts"].replace("this.items.push(price);", "this.items.push(+price);"));
    const [first] = await core.refreshOwnership("alpha");
    const [again] = await core.refreshOwnership("alpha");
    assert.equal(again!.updatedAt, first!.updatedAt, "nothing recomputed");
    // One more edit: the untouched file's analysis is reused, the edited one is redone.
    write(a.worktree.path, "src/cart.ts", SHOP["src/cart.ts"].replace("this.items.push(price);", "this.items.push(Number(price));"));
    const [third] = await core.refreshOwnership("alpha");
    assert.notEqual(third!.snapshot, first!.snapshot);
    assert.deepEqual(third!.files.map((f) => [f.path, f.symbols.map((s) => s.name)]).sort(), [["src/cart.ts", ["Cart.add"]], ["src/pricing.ts", ["applyDiscount"]]]);
  } finally {
    await core.close();
  }
});
