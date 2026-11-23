import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import * as path from "node:path";
import type { Range, SymbolKind } from "@synapse/protocol";
import { Language, Parser, type Node as TsNode } from "web-tree-sitter";

/**
 * Symbol extraction with tree-sitter (WASM grammars, no native build).
 *
 * For each file we extract:
 *  - definitions (functions, methods, classes, types...) with a qualified
 *    name, a range, a normalized signature, and a hash of the symbol's own
 *    text (excluding nested member definitions, so editing one method does
 *    not mark its whole class as modified);
 *  - call sites with the callee's short name and the enclosing definition.
 */

export interface ParsedSymbol {
  name: string;
  shortName: string;
  kind: SymbolKind;
  range: Range;
  signature?: string;
  /** Accepted argument counts for functions and methods (max is Infinity with rest parameters). */
  params?: { min: number; max: number };
  /** Hash of the symbol's own normalized text. */
  textHash: string;
}

export interface CallRef {
  callee: string;
  /** Number of arguments, or undefined when it cannot be known (spread arguments). */
  argCount?: number;
  line: number;
  text: string;
  inSymbol?: string;
}

export interface ParsedFile {
  language: string;
  symbols: ParsedSymbol[];
  calls: CallRef[];
}

type LangId = "typescript" | "tsx" | "javascript" | "python" | "go" | "rust" | "java";

const EXTENSIONS: Record<string, LangId> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
};

export function languageFor(filePath: string): LangId | undefined {
  return EXTENSIONS[path.extname(filePath).toLowerCase()];
}

// ---------------------------------------------------------------------------
// Language specs

interface DefSpec {
  kind: SymbolKind;
  /** Container definitions hold member definitions (classes, impls, traits). */
  container?: boolean;
  name?: (n: TsNode) => string | undefined;
  /** Fields whose text forms the signature (functions and methods). */
  sig?: string[];
}

interface LangSpec {
  defs: Record<string, DefSpec>;
  calls: Record<string, (n: TsNode) => string | undefined>;
  /** Variable declarations handled at module scope (and as class fields). */
  vars?: { decl: string[]; declarator: string; fields?: string[]; functionValues: string[] };
}

const field = (name: string) => (n: TsNode) => n.childForFieldName(name)?.text;

const lastIdentifier = (n: TsNode | null | undefined): string | undefined => {
  if (!n) return undefined;
  switch (n.type) {
    case "identifier":
    case "property_identifier":
    case "field_identifier":
    case "type_identifier":
    case "private_property_identifier":
      return n.text;
    case "member_expression":
      return lastIdentifier(n.childForFieldName("property"));
    case "attribute":
      return lastIdentifier(n.childForFieldName("attribute"));
    case "selector_expression":
      return lastIdentifier(n.childForFieldName("field"));
    case "field_expression":
      return lastIdentifier(n.childForFieldName("field"));
    case "scoped_identifier":
      return lastIdentifier(n.childForFieldName("name"));
    case "generic_function":
    case "generic_type":
      return lastIdentifier(n.childForFieldName("function") ?? n.namedChild(0));
    default:
      return undefined;
  }
};

const JS_DEFS: Record<string, DefSpec> = {
  function_declaration: { kind: "function", sig: ["type_parameters", "parameters", "return_type"] },
  generator_function_declaration: { kind: "function", sig: ["type_parameters", "parameters", "return_type"] },
  function_signature: { kind: "function", sig: ["type_parameters", "parameters", "return_type"] },
  class_declaration: { kind: "class", container: true },
  abstract_class_declaration: { kind: "class", container: true },
  method_definition: { kind: "method", sig: ["type_parameters", "parameters", "return_type"] },
  method_signature: { kind: "method", sig: ["type_parameters", "parameters", "return_type"] },
  abstract_method_signature: { kind: "method", sig: ["type_parameters", "parameters", "return_type"] },
  interface_declaration: { kind: "interface", container: true },
  type_alias_declaration: { kind: "type" },
  enum_declaration: { kind: "enum" },
  internal_module: { kind: "module", container: true },
};

const JS_CALLS: LangSpec["calls"] = {
  call_expression: (n) => lastIdentifier(n.childForFieldName("function")),
  new_expression: (n) => lastIdentifier(n.childForFieldName("constructor")),
};

const JS_VARS: LangSpec["vars"] = {
  decl: ["lexical_declaration", "variable_declaration"],
  declarator: "variable_declarator",
  fields: ["public_field_definition", "field_definition"],
  functionValues: ["arrow_function", "function_expression", "function", "generator_function"],
};

const SPECS: Record<LangId, LangSpec> = {
  typescript: { defs: JS_DEFS, calls: JS_CALLS, vars: JS_VARS },
  tsx: { defs: JS_DEFS, calls: JS_CALLS, vars: JS_VARS },
  javascript: { defs: JS_DEFS, calls: JS_CALLS, vars: JS_VARS },
  python: {
    defs: {
      function_definition: { kind: "function", sig: ["parameters", "return_type"] },
      class_definition: { kind: "class", container: true },
    },
    calls: { call: (n) => lastIdentifier(n.childForFieldName("function")) },
  },
  go: {
    defs: {
      function_declaration: { kind: "function", sig: ["type_parameters", "parameters", "result"] },
      method_declaration: {
        kind: "method",
        sig: ["parameters", "result"],
        name: (n) => {
          const recv = n.childForFieldName("receiver");
          const typeName = recv ? findFirst(recv, "type_identifier")?.text : undefined;
          const name = n.childForFieldName("name")?.text;
          return typeName && name ? `${typeName}.${name}` : name;
        },
      },
      type_spec: { kind: "type" },
    },
    calls: { call_expression: (n) => lastIdentifier(n.childForFieldName("function")) },
  },
  rust: {
    defs: {
      function_item: { kind: "function", sig: ["type_parameters", "parameters", "return_type"] },
      function_signature_item: { kind: "function", sig: ["type_parameters", "parameters", "return_type"] },
      struct_item: { kind: "class" },
      enum_item: { kind: "enum" },
      trait_item: { kind: "interface", container: true },
      type_item: { kind: "type" },
      mod_item: { kind: "module", container: true },
      impl_item: {
        kind: "class",
        container: true,
        name: (n) => {
          const t = n.childForFieldName("type");
          return t ? (lastIdentifier(t) ?? t.text.replace(/<.*$/s, "")) : undefined;
        },
      },
    },
    calls: {
      call_expression: (n) => lastIdentifier(n.childForFieldName("function")),
      macro_invocation: () => undefined,
    },
  },
  java: {
    defs: {
      class_declaration: { kind: "class", container: true },
      interface_declaration: { kind: "interface", container: true },
      enum_declaration: { kind: "enum", container: true },
      record_declaration: { kind: "class", container: true },
      method_declaration: { kind: "method", sig: ["type_parameters", "type", "parameters"] },
      constructor_declaration: { kind: "method", sig: ["parameters"] },
    },
    calls: {
      method_invocation: (n) => n.childForFieldName("name")?.text,
      object_creation_expression: (n) => lastIdentifier(n.childForFieldName("type")),
    },
  },
};

function findFirst(node: TsNode, type: string): TsNode | undefined {
  if (node.type === type) return node;
  for (const child of node.namedChildren) {
    if (!child) continue;
    const f = findFirst(child, type);
    if (f) return f;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Arity

const OPTIONAL_PARAMS = new Set(["optional_parameter", "assignment_pattern", "default_parameter", "typed_default_parameter"]);
const REST_PARAMS = new Set(["rest_pattern", "list_splat_pattern", "dictionary_splat_pattern", "variadic_parameter_declaration", "spread_parameter", "variadic_parameter"]);
const SKIP_PARAMS = new Set(["comment", "self_parameter", "keyword_separator", "positional_separator", "this"]);
const SPREAD_ARGS = new Set(["spread_element", "list_splat", "dictionary_splat", "variadic_argument"]);

function paramsNode(n: TsNode): TsNode | null {
  return n.childForFieldName("parameters") ?? n.childForFieldName("parameter");
}

function arityOf(n: TsNode, kind: SymbolKind, lang: LangId): { min: number; max: number } | undefined {
  const list = paramsNode(n);
  if (!list) return undefined;
  // A single unparenthesized arrow-function parameter.
  if (list.type === "identifier") return { min: 1, max: 1 };
  let min = 0;
  let max = 0;
  let first = true;
  for (const p of list.namedChildren) {
    if (!p || SKIP_PARAMS.has(p.type)) continue;
    if (lang === "python" && first && kind === "method" && p.type === "identifier" && (p.text === "self" || p.text === "cls")) {
      first = false;
      continue;
    }
    first = false;
    if (REST_PARAMS.has(p.type) || (p.namedChildren.some((c) => c && REST_PARAMS.has(c.type)))) {
      max = Infinity;
      continue;
    }
    // Go: `a, b int` declares two parameters.
    const count = p.type === "parameter_declaration" ? Math.max(1, p.namedChildren.filter((c) => c?.type === "identifier").length) : 1;
    const optional = OPTIONAL_PARAMS.has(p.type) || (p.type === "required_parameter" && !!p.childForFieldName("value"));
    if (!optional) min += count;
    max += count;
  }
  return { min, max };
}

function argCountOf(call: TsNode): number | undefined {
  const args = call.childForFieldName("arguments");
  if (!args) return call.type === "new_expression" ? 0 : undefined;
  let n = 0;
  for (const a of args.namedChildren) {
    if (!a || a.type === "comment") continue;
    if (SPREAD_ARGS.has(a.type)) return undefined;
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Parser lifecycle

const require = createRequire(import.meta.url);
let initPromise: Promise<void> | undefined;
const languages = new Map<LangId, Promise<Language>>();

function grammarPath(lang: LangId): string {
  const file = `tree-sitter-${lang}.wasm`;
  const dir = process.env.SYNAPSE_GRAMMARS_DIR;
  if (dir) return path.join(dir, file);
  return require.resolve(`tree-sitter-wasms/out/${file}`);
}

async function getLanguage(lang: LangId): Promise<Language> {
  if (!initPromise) initPromise = Parser.init();
  await initPromise;
  let p = languages.get(lang);
  if (!p) {
    p = Language.load(grammarPath(lang));
    languages.set(lang, p);
  }
  return p;
}

const CACHE_LIMIT = 1000;
const cache = new Map<string, ParsedFile>();

/** Parses `content` as the language implied by `filePath`. Returns null for unsupported languages. */
export async function parseSource(filePath: string, content: string): Promise<ParsedFile | null> {
  const lang = languageFor(filePath);
  if (!lang) return null;
  const key = `${lang}:${createHash("sha1").update(content).digest("hex")}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const language = await getLanguage(lang);
  const parser = new Parser();
  try {
    parser.setLanguage(language);
    const tree = parser.parse(content);
    if (!tree) return null;
    try {
      const parsed = extract(lang, tree.rootNode, content);
      cache.set(key, parsed);
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      return parsed;
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}

// ---------------------------------------------------------------------------
// Extraction

interface Scope {
  qualifier: string[];
  /** Kind of the nearest enclosing container, if any. */
  container?: SymbolKind;
  /** Enclosing definition for call attribution. Set inside function bodies. */
  enclosing?: string;
  /** Inside a function body: nested definitions are not separate symbols. */
  inBody: boolean;
  moduleLevel: boolean;
}

interface Collected extends ParsedSymbol {
  start: number;
  end: number;
  children: { start: number; end: number }[];
}

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

function rangeOf(n: TsNode): Range {
  return {
    startLine: n.startPosition.row,
    startCol: n.startPosition.column,
    endLine: n.endPosition.row,
    endCol: n.endPosition.column,
  };
}

function extract(lang: LangId, root: TsNode, source: string): ParsedFile {
  const spec = SPECS[lang];
  const symbols: Collected[] = [];
  const calls: CallRef[] = [];
  const lines = source.split("\n");
  const seen = new Map<string, number>();
  const stack: Collected[] = [];

  const uniqueName = (name: string) => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name}~${n}`;
  };

  const signatureOf = (n: TsNode, fields: string[] | undefined) => {
    if (!fields) return undefined;
    const parts: string[] = [];
    for (const f of fields) {
      const c = n.childForFieldName(f) ?? (f === "parameters" ? n.childForFieldName("parameter") : null);
      if (c) parts.push(normalize(c.text));
    }
    return parts.length ? parts.join(" ") : undefined;
  };

  const addSymbol = (node: TsNode, name: string, kind: SymbolKind, scope: Scope, signature?: string, sigNode?: TsNode): Collected => {
    const qualified = uniqueName([...scope.qualifier, name].join("."));
    const sym: Collected = {
      name: qualified,
      shortName: name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name,
      kind,
      range: rangeOf(node),
      signature,
      params: (kind === "function" || kind === "method") && sigNode ? arityOf(sigNode, kind, lang) : undefined,
      textHash: "",
      start: node.startIndex,
      end: node.endIndex,
      children: [],
    };
    const parent = stack[stack.length - 1];
    if (parent && sym.start >= parent.start && sym.end <= parent.end) parent.children.push({ start: sym.start, end: sym.end });
    symbols.push(sym);
    return sym;
  };

  const walk = (node: TsNode, scope: Scope): void => {
    const type = node.type;

    // Calls are recorded everywhere.
    const callFn = spec.calls[type];
    if (callFn) {
      const callee = callFn(node);
      if (callee) {
        const row = node.startPosition.row;
        calls.push({ callee, argCount: argCountOf(node), line: row, text: (lines[row] ?? "").trim().slice(0, 200), inSymbol: scope.enclosing });
      }
    }

    if (!scope.inBody) {
      const def = spec.defs[type];
      if (def) {
        const name = def.name ? def.name(node) : (node.childForFieldName("name")?.text ?? undefined);
        if (name) {
          let kind = def.kind;
          if (kind === "function" && scope.container && scope.container !== "module") kind = "method";
          const sym = addSymbol(node, name, kind, scope, signatureOf(node, def.sig), node);
          stack.push(sym);
          const childScope: Scope = def.container
            ? { qualifier: [...scope.qualifier, name], container: kind, enclosing: sym.name, inBody: false, moduleLevel: kind === "module" }
            : { qualifier: scope.qualifier, container: scope.container, enclosing: sym.name, inBody: true, moduleLevel: false };
          for (const child of node.namedChildren) if (child) walk(child, childScope);
          stack.pop();
          return;
        }
      }

      const vars = spec.vars;
      if (vars && scope.moduleLevel && vars.decl.includes(type)) {
        for (const decl of node.namedChildren) {
          if (!decl || decl.type !== vars.declarator) {
            if (decl) walk(decl, scope);
            continue;
          }
          const nameNode = decl.childForFieldName("name");
          const value = decl.childForFieldName("value");
          if (!nameNode || nameNode.type !== "identifier") {
            walk(decl, scope);
            continue;
          }
          const isFn = !!value && vars.functionValues.includes(value.type);
          const sym = addSymbol(decl, nameNode.text, isFn ? "function" : "variable", scope, isFn && value ? signatureOf(value, ["type_parameters", "parameters", "return_type"]) : undefined, isFn && value ? value : undefined);
          stack.push(sym);
          const inner: Scope = { ...scope, enclosing: sym.name, inBody: true, moduleLevel: false };
          for (const c of decl.namedChildren) if (c) walk(c, inner);
          stack.pop();
        }
        return;
      }

      if (vars?.fields?.includes(type) && scope.container) {
        const nameNode = node.childForFieldName("name") ?? node.childForFieldName("property");
        const value = node.childForFieldName("value");
        if (nameNode && value && vars.functionValues.includes(value.type)) {
          const sym = addSymbol(node, nameNode.text, "method", scope, signatureOf(value, ["type_parameters", "parameters", "return_type"]), value);
          stack.push(sym);
          const inner: Scope = { ...scope, enclosing: sym.name, inBody: true, moduleLevel: false };
          for (const c of node.namedChildren) if (c) walk(c, inner);
          stack.pop();
          return;
        }
      }
    }

    // Wrappers that keep module level: export statements, Python decorators, Go type declarations, blocks of classes.
    const keepsModuleLevel =
      scope.moduleLevel &&
      (type === "export_statement" || type === "decorated_definition" || type === "type_declaration" || type === "ambient_declaration" || type === "statement_block");
    const childScope: Scope = keepsModuleLevel ? scope : { ...scope, moduleLevel: false };
    for (const child of node.namedChildren) if (child) walk(child, childScope);
  };

  const rootScope: Scope = { qualifier: [], inBody: false, moduleLevel: true };
  for (const child of root.namedChildren) if (child) walk(child, rootScope);

  for (const sym of symbols) {
    let own = "";
    let cursor = sym.start;
    for (const child of [...sym.children].sort((a, b) => a.start - b.start)) {
      if (child.start < cursor) continue;
      own += source.slice(cursor, child.start) + "\u0000";
      cursor = child.end;
    }
    own += source.slice(cursor, sym.end);
    sym.textHash = createHash("sha1").update(normalize(own)).digest("hex").slice(0, 16);
  }

  return {
    language: lang,
    symbols: symbols.map(({ start: _s, end: _e, children: _c, ...rest }) => rest),
    calls,
  };
}
