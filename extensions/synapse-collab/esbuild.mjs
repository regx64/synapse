// Bundles the extension, and a self-contained copy of synapse-core (plus the
// mock agent) that the extension runs as a separate process.
import { build } from "esbuild";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const out = path.resolve("dist");
fs.rmSync(out, { recursive: true, force: true });

await build({
  entryPoints: ["src/extension.ts"],
  outfile: path.join(out, "extension.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  sourcemap: true,
});

const esm = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
};
await build({ ...esm, entryPoints: [require.resolve("@synapse/core/main")], outfile: path.join(out, "core", "main.mjs") });
await build({ ...esm, entryPoints: [path.join(path.dirname(require.resolve("@synapse/mock-agent/package.json")), "dist/src/main.js")], outfile: path.join(out, "core", "mock-agent.mjs") });

// tree-sitter runtime and the grammars synapse-core parses.
const wasmDir = path.join(out, "core", "wasm");
fs.mkdirSync(wasmDir, { recursive: true });
const coreRequire = createRequire(require.resolve("@synapse/core"));
fs.copyFileSync(path.join(path.dirname(coreRequire.resolve("web-tree-sitter")), "tree-sitter.wasm"), path.join(wasmDir, "tree-sitter.wasm"));
for (const lang of ["typescript", "tsx", "javascript", "python", "go", "rust", "java"]) {
  const f = `tree-sitter-${lang}.wasm`;
  fs.copyFileSync(coreRequire.resolve(`tree-sitter-wasms/out/${f}`), path.join(wasmDir, f));
}
console.log("built", path.relative(process.cwd(), out));
