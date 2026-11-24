import { test } from "node:test";
import assert from "node:assert/strict";
import { refersTo } from "../src/conflicts.js";
import { parseSource } from "../src/symbols.js";

/** Which calls named `name` in `src` (at `callPath`) can refer to the definition in `defPath`. */
async function matches(callPath: string, src: string, name: string, defPath: string, isMethod = false, className?: string) {
  const parsed = (await parseSource(callPath, src))!;
  return parsed.calls
    .filter((c) => c.callee === name || parsed.imports.some((b) => b.local === c.callee && b.imported === name))
    .map((c) => {
      const binding = parsed.imports.find((b) => b.local === c.callee && (b.kind === "named" || b.kind === "default"));
      return [c.text, refersTo(callPath, parsed, c, binding, defPath, isMethod, { className, text: src })] as const;
    });
}

test("Go: plain calls stay in their package; pkg.F() follows the import path", async () => {
  const src = `package checkout\nimport (\n  "example.com/shop/pricing"\n  other "example.com/shop/legacy"\n)\nfunc A() { pricing.Apply(1, 2) }\nfunc B() { other.Apply(1) }\nfunc C() { Apply(3) }\n`;
  assert.deepEqual(await matches("checkout/checkout.go", src, "Apply", "pricing/pricing.go"), [
    ["func A() { pricing.Apply(1, 2) }", true],
    ["func B() { other.Apply(1) }", false],
    ["func C() { Apply(3) }", false],
  ]);
  // Same package (folder): the plain call does refer to it.
  assert.deepEqual(await matches("pricing/cart.go", `package pricing\nfunc C() { Apply(3) }\n`, "Apply", "pricing/pricing.go"), [["func C() { Apply(3) }", true]]);
});

test("Go: a method call counts only where the package is visible", async () => {
  const seen = `package checkout\nimport "example.com/shop/pricing"\nfunc A(c *pricing.Cart) { c.Add(1) }\n`;
  const unseen = `package report\nimport "example.com/shop/metrics"\nfunc A(m *metrics.Counter) { m.Add(1) }\n`;
  assert.deepEqual(await matches("checkout/a.go", seen, "Add", "pricing/cart.go", true, "Cart"), [["func A(c *pricing.Cart) { c.Add(1) }", true]]);
  assert.deepEqual(await matches("report/a.go", unseen, "Add", "pricing/cart.go", true, "Cart"), [["func A(m *metrics.Counter) { m.Add(1) }", false]]);
});

test("Java: class imports, static imports and the same package", async () => {
  const src = `package app;\nimport shop.pricing.Pricing;\nimport static shop.pricing.Pricing.apply;\nimport other.Legacy;\nclass App {\n  void a() { Pricing.apply(1, 2); }\n  void b() { apply(3); }\n  void c() { Legacy.apply(4); }\n}\n`;
  assert.deepEqual(await matches("src/main/java/app/App.java", src, "apply", "src/main/java/shop/pricing/Pricing.java", true, "Pricing"), [
    ["void a() { Pricing.apply(1, 2); }", true],
    ["void b() { apply(3); }", true],
    ["void c() { Legacy.apply(4); }", false],
  ]);
  const unrelated = `package report;\nimport other.Counter;\nclass R { void a(Counter c) { c.add(1); } }\n`;
  assert.deepEqual(await matches("src/main/java/report/R.java", unrelated, "add", "src/main/java/shop/Cart.java", true, "Cart"), [["class R { void a(Counter c) { c.add(1); } }", false]]);
});

test("Rust: use declarations and crate paths", async () => {
  const src = `use crate::pricing;\nuse crate::legacy::apply as old_apply;\nfn a() { pricing::apply(1); }\nfn b() { crate::pricing::apply(2); }\nfn c() { old_apply(3); }\nfn d() { crate::legacy::apply(4); }\n`;
  assert.deepEqual(await matches("src/checkout.rs", src, "apply", "src/pricing.rs"), [
    ["fn a() { pricing::apply(1); }", true],
    ["fn b() { crate::pricing::apply(2); }", true],
    ["fn c() { old_apply(3); }", false],
    ["fn d() { crate::legacy::apply(4); }", false],
  ]);
  assert.deepEqual(await matches("src/checkout.rs", `use crate::pricing::apply;\nfn a() { apply(1); }\n`, "apply", "src/pricing/mod.rs"), [["fn a() { apply(1); }", true]]);
});

test("JavaScript and Python: method calls need the defining module in view", async () => {
  const ts = `import { Cart } from "./cart";\nimport { api } from "./api";\nconst c = new Cart();\nc.add(1);\napi.add(2);\n`;
  // Both are visible here (the file imports ./cart), so both count; in a file that never imports ./cart nor names Cart, neither does.
  assert.deepEqual((await matches("src/a.ts", ts, "add", "src/cart.ts", true, "Cart")).map(([, ok]) => ok), [true, true]);
  const other = `import { api } from "./api";\napi.add(2);\n`;
  assert.deepEqual(await matches("src/b.ts", other, "add", "src/cart.ts", true, "Cart"), [["api.add(2);", false]]);
  const py = `import pricing\nimport legacy\npricing.apply(1, 2)\nlegacy.apply(3)\n`;
  assert.deepEqual(await matches("app/checkout.py", py, "apply", "pricing.py"), [
    ["pricing.apply(1, 2)", true],
    ["legacy.apply(3)", false],
  ]);
});
