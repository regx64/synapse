import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

export class GitError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
    public readonly code: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface GitOptions {
  env?: Record<string, string>;
  input?: string;
}

/** Identity used for commits Synapse makes itself (snapshots, integration merges). */
export const SYNAPSE_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: "Synapse",
  GIT_AUTHOR_EMAIL: "synapse@localhost",
  GIT_COMMITTER_NAME: "Synapse",
  GIT_COMMITTER_EMAIL: "synapse@localhost",
};

export function runGit(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  return runGitRaw(cwd, args, opts).then((r) => ({ stdout: r.stdout.toString("utf8"), stderr: r.stderr, code: r.code }));
}

/** Like runGit, with stdout as bytes (for output that mixes byte counts and content). */
function runGitRaw(cwd: string, args: string[], opts: GitOptions = {}): Promise<{ stdout: Buffer; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8"), code });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Runs git and returns trimmed stdout; throws GitError on a non-zero exit. */
export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  const r = await runGit(cwd, args, opts);
  if (r.code !== 0) {
    throw new GitError(`git ${args.join(" ")} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`, args, r.code, r.stderr);
  }
  return r.stdout.replace(/\s+$/, "");
}

export async function revParse(cwd: string, ref: string): Promise<string> {
  return git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
}

export async function tryRevParse(cwd: string, ref: string): Promise<string | undefined> {
  const r = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

export async function repoRootOf(dir: string): Promise<string> {
  return git(dir, ["rev-parse", "--show-toplevel"]);
}

export async function currentBranch(cwd: string): Promise<string | undefined> {
  const r = await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** Contents of `path` at `rev`, or null when the path does not exist there. */
export async function showFile(cwd: string, rev: string, filePath: string): Promise<string | null> {
  const r = await runGit(cwd, ["show", `${rev}:${filePath}`]);
  return r.code === 0 ? r.stdout : null;
}

export async function readBlob(cwd: string, oid: string): Promise<string> {
  const text = (await readBlobs(cwd, [oid])).get(oid);
  if (text === undefined) throw new GitError(`git cat-file: blob ${oid} not found`, ["cat-file"], 1, "");
  return text;
}

// Blobs are content-addressed and never change, so their text can be cached by id.
const BLOB_CACHE_BYTES = 64 * 1024 * 1024;
const blobCache = new Map<string, string>();
let blobCacheBytes = 0;

function cacheBlob(oid: string, text: string): void {
  if (text.length > BLOB_CACHE_BYTES / 16) return;
  blobCache.set(oid, text);
  blobCacheBytes += text.length;
  for (const [k, v] of blobCache) {
    if (blobCacheBytes <= BLOB_CACHE_BYTES) break;
    blobCache.delete(k);
    blobCacheBytes -= v.length;
  }
}

/**
 * Reads many blobs with one `git cat-file --batch`. Missing blobs are left out
 * of the result. Cached by blob id.
 */
export async function readBlobs(cwd: string, oids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const missing: string[] = [];
  for (const oid of new Set(oids)) {
    const hit = blobCache.get(oid);
    if (hit === undefined) missing.push(oid);
    else {
      blobCache.delete(oid); // keep recently used blobs last
      blobCache.set(oid, hit);
      out.set(oid, hit);
    }
  }
  if (!missing.length) return out;
  const r = await runGitRaw(cwd, ["cat-file", "--batch"], { input: missing.join("\n") + "\n" });
  if (r.code !== 0) throw new GitError(`git cat-file --batch failed: ${r.stderr.trim()}`, ["cat-file", "--batch"], r.code, r.stderr);
  // Each answer: "<oid> <type> <size>\n<size bytes>\n", or "<oid> missing\n".
  let at = 0;
  const buf = r.stdout;
  while (at < buf.length) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) break;
    const [oid, type, size] = buf.subarray(at, nl).toString("utf8").split(" ");
    at = nl + 1;
    if (type === "missing" || size === undefined) continue;
    const n = Number(size);
    const text = buf.subarray(at, at + n).toString("utf8");
    at += n + 1;
    if (type === "blob" && oid) {
      out.set(oid, text);
      cacheBlob(oid, text);
    }
  }
  return out;
}

/**
 * Writes a commit that captures the worktree at `cwd`, including uncommitted
 * and untracked (but not ignored) files, without touching the worktree, its
 * index, or any branch. Returns HEAD itself when nothing changed.
 *
 * With `indexFile`, that private index is kept between calls (it is rebuilt
 * only when HEAD moves), so git re-hashes only files whose stat data changed
 * instead of every file in the worktree. Calls for one index must not overlap.
 */
export async function snapshotWorktree(cwd: string, message: string, indexFile?: string): Promise<string> {
  // HEAD, its tree and its commit time in one call.
  const [head, headTree, time] = (await git(cwd, ["log", "-1", "--format=%H%n%T%n%ct", "HEAD"])).split("\n");
  if (!head || !headTree || !time) throw new GitError("git log -1 HEAD gave no commit", ["log"], 1, "");
  const temporary = !indexFile;
  const index = indexFile ?? path.join(os.tmpdir(), `synapse-index-${process.pid}-${randomBytes(4).toString("hex")}`);
  const env = { GIT_INDEX_FILE: index, ...SYNAPSE_IDENTITY };
  const headMark = `${index}.head`;
  try {
    const builtFrom = temporary ? undefined : await fs.readFile(headMark, "utf8").catch(() => undefined);
    if (builtFrom !== head) {
      await git(cwd, ["read-tree", head], { env });
      if (!temporary) await fs.writeFile(headMark, head);
    }
    await git(cwd, ["add", "-A", "--", "."], { env });
    const tree = await git(cwd, ["write-tree"], { env });
    if (tree === headTree) return head;
    // Deterministic: the same tree on the same parent always gives the same commit,
    // so "did this agent change anything since?" is a plain comparison.
    const date = `${time} +0000`;
    return await git(cwd, ["commit-tree", tree, "-p", head, "-m", message], { env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  } catch (err) {
    // A broken private index must not wedge future snapshots.
    if (!temporary) await fs.rm(headMark, { force: true });
    throw err;
  } finally {
    if (temporary) await fs.rm(index, { force: true });
  }
}

export interface RawDiffEntry {
  status: "added" | "modified" | "deleted";
  path: string;
  oldOid?: string;
  newOid?: string;
}

const ZERO_OID = /^0+$/;

/** `git diff --raw` between two commits, without rename detection. */
export async function diffRaw(cwd: string, from: string, to: string): Promise<RawDiffEntry[]> {
  const out = await git(cwd, ["diff", "--raw", "-z", "--no-renames", "--abbrev=40", from, to]);
  const parts = out.split("\0").filter((p) => p.length > 0);
  const entries: RawDiffEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i]!.replace(/^:/, "").split(" ");
    const filePath = parts[i + 1]!;
    const [, , oldOid, newOid, statusLetter] = meta;
    const s = (statusLetter ?? "M")[0];
    const status = s === "A" ? "added" : s === "D" ? "deleted" : "modified";
    entries.push({
      status,
      path: filePath,
      oldOid: oldOid && !ZERO_OID.test(oldOid) ? oldOid : undefined,
      newOid: newOid && !ZERO_OID.test(newOid) ? newOid : undefined,
    });
  }
  return entries;
}

/** Lines added/removed per path. Binary files report 0/0. */
export async function diffNumstat(cwd: string, from: string, to: string): Promise<Map<string, { added: number; removed: number }>> {
  const out = await git(cwd, ["diff", "--numstat", "-z", "--no-renames", from, to]);
  const map = new Map<string, { added: number; removed: number }>();
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(rec);
    if (!m) continue;
    map.set(m[3]!, { added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]) });
  }
  return map;
}

/**
 * Predicts whether two commits merge cleanly, without touching any worktree
 * (`git merge-tree --write-tree`, git >= 2.38). Returns conflicted paths.
 */
export async function predictMergeConflicts(cwd: string, a: string, b: string): Promise<{ clean: boolean; paths: string[] }> {
  const r = await runGit(cwd, ["merge-tree", "--write-tree", "--name-only", "--no-messages", a, b]);
  if (r.code === 0) return { clean: true, paths: [] };
  if (r.code === 1) {
    const lines = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    return { clean: false, paths: [...new Set(lines.slice(1))] };
  }
  throw new GitError(`git merge-tree failed: ${r.stderr.trim()}`, ["merge-tree"], r.code, r.stderr);
}

export async function isWorkingTreeClean(cwd: string): Promise<boolean> {
  const out = await git(cwd, ["status", "--porcelain", "--untracked-files=normal"]);
  return out.trim().length === 0;
}

/** Makes git ignore `.synapse/` in this repository without editing tracked files. */
export async function ensureLocalExclude(repoRoot: string, pattern: string): Promise<void> {
  const commonDir = path.resolve(repoRoot, await git(repoRoot, ["rev-parse", "--git-common-dir"]));
  const excludeFile = path.join(commonDir, "info", "exclude");
  await fs.mkdir(path.dirname(excludeFile), { recursive: true });
  let current = "";
  try {
    current = await fs.readFile(excludeFile, "utf8");
  } catch {
    /* new file */
  }
  if (current.split(/\r?\n/).includes(pattern)) return;
  const prefix = current.length && !current.endsWith("\n") ? "\n" : "";
  await fs.appendFile(excludeFile, `${prefix}# Added by Synapse\n${pattern}\n`);
}
