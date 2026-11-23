// Benchmark: ownership refresh and conflict check at a realistic size (risk T5).
// Needs a build (npm run build).
//   node scripts/bench.mjs [files=400] [agents=3] [edits=60]
import { performance } from "node:perf_hooks";
const { SynapseCore } = await import(new URL("../packages/core/dist/src/index.js", import.meta.url).href);
const { makeRepo, write } = await import(new URL("../packages/core/dist/src/testing.js", import.meta.url).href);
const [N = 400, A = 3, E = 60] = process.argv.slice(2).map(Number);
const file = (i, v = 0) => {
  const lines = [`import { helper${(i + 1) % N} } from "./m${(i + 1) % N}";`, ""];
  for (let f = 0; f < 12; f++) lines.push(`export function helper${i}_${f}(a: number, b: number): number {`, `  const x = a * ${f} + b; // v${v}`, `  return helper${(i + 1) % N}(x, ${f}) + x;`, `}`, "");
  lines.push(`export function helper${i}(a: number, b: number): number { return a + b; }`, "");
  lines.push(`export class C${i} {`, ...Array.from({ length: 8 }, (_, m) => `  m${m}(n: number): number { return helper${i}(n, ${m}); }`), `}`, "");
  return lines.join("\n");
};
const files = {};
for (let i = 0; i < N; i++) files[`src/m${i}.ts`] = file(i);
const repo = makeRepo(files);
const core = await SynapseCore.open({ workspace: repo, ephemeral: true });
const agents = [];
for (let a = 0; a < A; a++) agents.push(await core.agents.add({ preset: "mock", id: `a${a}` }));
// Each agent edits E files; agents overlap on some files.
for (const [k, ag] of agents.entries()) for (let e = 0; e < E; e++) write(ag.worktree.path, `src/m${(k * (E / 2) + e) % N}.ts`, file((k * (E / 2) + e) % N, k + 1));
const t = async (label, fn) => { const s = performance.now(); const r = await fn(); const ms = performance.now() - s; console.log(`${label.padEnd(42)} ${ms.toFixed(0).padStart(6)} ms`); return r; };
await t("first refresh, all agents (cold parse)", () => Promise.all(agents.map((a) => core.ownership.refresh(a.id))));
await t("conflict check", () => core.checkConflicts());
await t("refresh again, nothing changed", () => Promise.all(agents.map((a) => core.ownership.refresh(a.id))));
await t("conflict check again, nothing changed", () => core.checkConflicts());
write(agents[0].worktree.path, "src/m0.ts", file(0, 9));
await t("refresh one agent after 1-file edit", () => core.ownership.refresh("a0"));
await t("conflict check after 1-file edit", () => core.checkConflicts());
console.log(`conflicts: ${core.store.getConflicts().length}`);
await core.close();
