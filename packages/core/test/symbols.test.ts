import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSource, diffSymbols } from "../src/index.js";

test("extracts TypeScript definitions with qualified names and signatures", async () => {
  const src = `export function add(a: number, b: number): number { return a + b; }
export const mul = (a: number, b: number) => a * b;
const LIMIT = 3;
export class Cart {
  items: number[] = [];
  add(x: number) { return add(x, 1); }
  static create(): Cart { return new Cart(); }
}
interface Shape { area(): number }
type Id = string;
enum Color { Red }
`;
  const parsed = (await parseSource("a.ts", src))!;
  const byName = Object.fromEntries(parsed.symbols.map((s) => [s.name, s]));
  assert.equal(byName["add"]!.kind, "function");
  assert.equal(byName["add"]!.signature, "(a: number, b: number) : number");
  assert.equal(byName["mul"]!.kind, "function");
  assert.equal(byName["LIMIT"]!.kind, "variable");
  assert.equal(byName["Cart"]!.kind, "class");
  assert.equal(byName["Cart.add"]!.kind, "method");
  assert.equal(byName["Cart.create"]!.kind, "method");
  assert.equal(byName["Shape"]!.kind, "interface");
  assert.equal(byName["Shape.area"]!.kind, "method");
  assert.equal(byName["Id"]!.kind, "type");
  assert.equal(byName["Color"]!.kind, "enum");
  const call = parsed.calls.find((c) => c.callee === "add")!;
  assert.equal(call.inSymbol, "Cart.add");
  assert.ok(parsed.calls.some((c) => c.callee === "Cart" && c.inSymbol === "Cart.create"));
});

test("editing one method does not mark the class or sibling methods as modified", async () => {
  const before = `class A {\n  x = 1;\n  m() { return 1; }\n  n() { return 2; }\n}\n`;
  const after = `class A {\n  x = 1;\n  m() { return 42; }\n  n() { return 2; }\n}\n`;
  const diff = diffSymbols(await parseSource("a.ts", before), await parseSource("a.ts", after));
  assert.deepEqual(diff.map((d) => [d.name, d.change]), [["A.m", "modified"]]);
  assert.equal(diff[0]!.signatureChanged, false);
});

test("detects signature changes, additions and removals; ignores whitespace", async () => {
  const before = `export function f(a: number) { return a; }\nexport function g() {}\nexport function h() {   return 1; }\n`;
  const after = `export function f(a: number, b = 2) { return a; }\nexport function k() {}\nexport function h() { return 1; }\n`;
  const diff = diffSymbols(await parseSource("a.ts", before), await parseSource("a.ts", after));
  const m = Object.fromEntries(diff.map((d) => [d.name, d]));
  assert.equal(m["f"]!.signatureChanged, true);
  assert.equal(m["f"]!.oldSignature, "(a: number)");
  assert.equal(m["f"]!.newSignature, "(a: number, b = 2)");
  assert.equal(m["k"]!.change, "added");
  assert.equal(m["g"]!.change, "removed");
  assert.equal(m["h"], undefined);
});

test("Python, Go, Rust and Java definitions and calls", async () => {
  const py = (await parseSource("m.py", `class Cart:\n    def add(self, x):\n        return helper(x)\n\ndef helper(x, y=1):\n    return x\n`))!;
  assert.deepEqual(py.symbols.map((s) => [s.name, s.kind]), [["Cart", "class"], ["Cart.add", "method"], ["helper", "function"]]);
  assert.equal(py.calls[0]!.callee, "helper");
  assert.equal(py.calls[0]!.inSymbol, "Cart.add");

  const go = (await parseSource("m.go", `package p\ntype S struct{}\nfunc (s *S) M(a int) int { return F(a) }\nfunc F(a int) int { return a }\n`))!;
  assert.deepEqual(go.symbols.map((s) => [s.name, s.kind]), [["S", "type"], ["S.M", "method"], ["F", "function"]]);
  assert.equal(go.calls[0]!.inSymbol, "S.M");

  const rs = (await parseSource("m.rs", `struct S;\nimpl S { fn m(&self) -> i32 { f(1) } }\nfn f(a: i32) -> i32 { a }\n`))!;
  assert.ok(rs.symbols.some((s) => s.name === "S.m" && s.kind === "method"));
  assert.ok(rs.calls.some((c) => c.callee === "f" && c.inSymbol === "S.m"));

  const java = (await parseSource("A.java", `class A { int m(int a) { return f(a); } int f(int a) { return a; } }`))!;
  assert.deepEqual(java.symbols.map((s) => s.name), ["A", "A.m", "A.f"]);
});

test("unsupported languages return null", async () => {
  assert.equal(await parseSource("README.md", "# hi"), null);
});

test("arity of definitions and argument counts of calls", async () => {
  const ts = (await parseSource("a.ts", `function f(a: number, b?: number, c = 1) {}\nfunction g(...xs: number[]) {}\nconst h = x => x;\nf(1); f(1, 2, 3, 4); g(...[1]); h(2);\n`))!;
  const p = Object.fromEntries(ts.symbols.map((s) => [s.name, s.params]));
  assert.deepEqual(p["f"], { min: 1, max: 3 });
  assert.deepEqual(p["g"], { min: 0, max: Infinity });
  assert.deepEqual(p["h"], { min: 1, max: 1 });
  assert.deepEqual(ts.calls.map((c) => c.argCount), [1, 4, undefined, 1]);

  const py = (await parseSource("m.py", `class A:\n    def m(self, a, b=2, *rest):\n        pass\n`))!;
  assert.deepEqual(py.symbols[1]!.params, { min: 1, max: Infinity });

  const go = (await parseSource("m.go", `package p\nfunc F(a, b int, c string) {}\n`))!;
  assert.deepEqual(go.symbols[0]!.params, { min: 3, max: 3 });
});

test("imports and member calls are recorded for resolution", async () => {
  const { moduleMatches } = await import("../src/conflicts.js");
  const ts = (await parseSource("src/a.ts", `import def, { x as y, z } from "./b.js";\nimport * as ns from "../c";\nconst { q, r: s } = require("./d");\ny(); ns.w(); obj.m();\n`))!;
  assert.deepEqual(ts.imports.map((i) => [i.local, i.imported, i.source, i.kind]), [
    ["def", "default", "./b.js", "default"],
    ["y", "x", "./b.js", "named"],
    ["z", "z", "./b.js", "named"],
    ["ns", "*", "../c", "namespace"],
    ["q", "q", "./d", "named"],
    ["s", "r", "./d", "named"],
  ]);
  assert.deepEqual(ts.calls.filter((c) => c.callee !== "require").map((c) => [c.callee, c.member]), [["y", false], ["w", true], ["m", true]]);
  assert.equal(ts.hasImports, true);

  const py = (await parseSource("shop/cart.py", `from .pricing import apply as ap, fmt\nfrom shop.tax import *\nap(1)\n`))!;
  assert.deepEqual(py.imports.map((i) => [i.local, i.imported, i.source]), [["ap", "apply", ".pricing"], ["fmt", "fmt", ".pricing"], ["*", "*", "shop.tax"]]);

  assert.ok(moduleMatches("src/a.ts", "./b.js", "src/b.ts"));
  assert.ok(moduleMatches("src/a.ts", "../lib", "lib/index.ts"));
  assert.ok(!moduleMatches("src/a.ts", "./old", "src/b.ts"));
  assert.ok(moduleMatches("src/a.ts", "@/lib/b", "src/lib/b.ts"));
  assert.ok(moduleMatches("shop/cart.py", ".pricing", "shop/pricing.py"));
  assert.ok(moduleMatches("shop/sub/x.py", "..pricing", "shop/pricing.py"));
  assert.ok(moduleMatches("app.py", "shop.pricing", "src/shop/pricing.py"));
  assert.ok(!moduleMatches("app.py", "numpy", "src/shop/pricing.py"));
});
