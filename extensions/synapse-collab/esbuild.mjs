// Bundles the extension, and a self-contained copy of synapse-core (plus the
// mock agent) that the extension runs as a separate process.
import { build } from "esbuild";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const out = path.resolve("dist");
fs.rmSync(out, { recursive: true, force: true });

// Every bundle reports its inputs, so the notices list exactly what ships.
const inputs = new Set();
const collect = (result) => Object.keys(result.metafile?.inputs ?? {}).forEach((i) => inputs.add(i));

collect(await build({
  metafile: true,
  entryPoints: ["src/extension.ts"],
  outfile: path.join(out, "extension.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  sourcemap: true,
}));

const esm = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
};
const esmm = { ...esm, metafile: true };
collect(await build({ ...esmm, entryPoints: [require.resolve("@synapse/core/main")], outfile: path.join(out, "core", "main.mjs") }));
collect(await build({ ...esmm, entryPoints: [path.join(path.dirname(require.resolve("@synapse/core/main")), "mcp-server.js")], outfile: path.join(out, "core", "mcp-server.mjs") }));
collect(await build({ ...esmm, entryPoints: [path.join(path.dirname(require.resolve("@synapse/mock-agent/package.json")), "dist/src/main.js")], outfile: path.join(out, "core", "mock-agent.mjs") }));

// tree-sitter runtime and the grammars synapse-core parses.
const wasmDir = path.join(out, "core", "wasm");
fs.mkdirSync(wasmDir, { recursive: true });
const coreRequire = createRequire(require.resolve("@synapse/core"));
fs.copyFileSync(path.join(path.dirname(coreRequire.resolve("web-tree-sitter")), "tree-sitter.wasm"), path.join(wasmDir, "tree-sitter.wasm"));
for (const lang of ["typescript", "tsx", "javascript", "python", "go", "rust", "java"]) {
  const f = `tree-sitter-${lang}.wasm`;
  fs.copyFileSync(coreRequire.resolve(`tree-sitter-wasms/out/${f}`), path.join(wasmDir, f));
}
// Third-party notices (MIT and similar licenses require shipping them).
const packages = new Map();
for (const input of inputs) {
  const posix = input.split(path.sep).join("/");
  const m = /^(.*?node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(posix);
  if (!m) continue;
  const [, dirRel, name] = m;
  if (name.startsWith("@synapse/") || packages.has(name)) continue; // @synapse/*: this repository, MIT
  packages.set(name, fs.realpathSync(path.resolve(dirRel)));
}
// Copied rather than bundled: the tree-sitter runtime's wasm and the grammars.
const packageDirOf = (file) => {
  for (let d = path.dirname(file); d !== path.dirname(d); d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, "package.json"))) return d;
  }
  throw new Error(`no package.json above ${file}`);
};
packages.set("web-tree-sitter", packageDirOf(coreRequire.resolve("web-tree-sitter")));
packages.set("tree-sitter-wasms", packageDirOf(coreRequire.resolve("tree-sitter-wasms/out/tree-sitter-go.wasm")));
const licenseText = (dir) => {
  const f = fs.readdirSync(dir).find((n) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(n));
  return f ? fs.readFileSync(path.join(dir, f), "utf8").trim() : undefined;
};
const sections = [];
for (const [name, dir] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const text = licenseText(dir);
  if (!text) throw new Error(`${name} ships in the bundle but has no license file; add its license text to licenses/`);
  sections.push(`${name} ${pkg.version} (${pkg.license ?? "see license"})\n\n${text}`);
}
const grammarsDir = path.resolve("licenses", "grammars");
for (const f of fs.readdirSync(grammarsDir).sort()) sections.push(fs.readFileSync(path.join(grammarsDir, f), "utf8").trim());
// Fonts in media/fonts (SIL Open Font License 1.1).
const fontsDir = path.resolve("licenses", "fonts");
for (const f of fs.readdirSync(fontsDir).sort()) sections.push(`${f.replace(/-OFL\.txt$/, "")} font (OFL-1.1)\n\n${fs.readFileSync(path.join(fontsDir, f), "utf8").trim()}`);
const header = [
  "Synapse Collaboration (synapse-collab) and synapse-core",
  "Copyright (c) 2026 The Synapse contributors. MIT License (see LICENSE).",
  "",
  "This extension includes the third-party software listed below. Each is",
  "provided under its own license, reproduced here.",
].join("\n");
const divider = "\n\n" + "-".repeat(78) + "\n\n";
fs.writeFileSync(path.join(out, "ThirdPartyNotices.txt"), header + divider + sections.join(divider) + "\n");
console.log(`notices: ${sections.length} third-party components`);
console.log("built", path.relative(process.cwd(), out));
