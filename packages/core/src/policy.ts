import type { AgentPolicy, PermissionQuery, PolicyDecision } from "@synapse/protocol";

/**
 * The phase 3 permission model (risk C1). Pure functions: given an agent's
 * policy and a request, decide allow / ask / deny and name the rule.
 *
 * Isolation does most of the work: an agent edits only its own worktree,
 * so edits there are allowed by default. Commands are the dangerous part:
 * they run as the user, outside Synapse's control, so the default is to ask
 * unless every part of a command is on the allow list.
 */

export const DEFAULT_POLICY: AgentPolicy = {
  writable: ["**"],
  protected: [
    ".env",
    ".env.*",
    "**/.env",
    "**/.env.*",
    "**/*.pem",
    "**/*.key",
    "**/*.p12",
    "**/id_rsa*",
    "**/id_ed25519*",
    "**/.npmrc",
    "**/.pypirc",
    "**/secrets/**",
    "**/.aws/**",
    "**/.ssh/**",
  ],
  edits: "allow",
  commands: {
    allow: [
      "git status*",
      "git diff*",
      "git log*",
      "git show*",
      "ls*",
      "pwd",
      "npm test*",
      "npm run test*",
      "npm run lint*",
      "npm run build*",
      "npx tsc*",
      "node --test*",
      "pytest*",
      "python -m pytest*",
      "go test*",
      "go build*",
      "go vet*",
      "cargo test*",
      "cargo check*",
      "cargo build*",
    ],
    deny: [
      "rm -rf /*",
      "rm -rf ~*",
      "rm -rf .git*",
      "sudo *",
      "git push*",
      "git remote *",
      "npm publish*",
      "cargo publish*",
      "* | sh",
      "* | bash",
      "chmod -R 777 *",
      "mkfs*",
      "dd if=*",
    ],
  },
  network: "ask",
  otherwise: "ask",
};

export function mergePolicy(base: AgentPolicy, patch: Partial<AgentPolicy> | undefined): AgentPolicy {
  if (!patch) return clone(base);
  return {
    writable: patch.writable ?? [...base.writable],
    protected: patch.protected ?? [...base.protected],
    edits: patch.edits ?? base.edits,
    commands: {
      allow: patch.commands?.allow ?? [...base.commands.allow],
      deny: patch.commands?.deny ?? [...base.commands.deny],
    },
    network: patch.network ?? base.network,
    otherwise: patch.otherwise ?? base.otherwise,
  };
}

const clone = (p: AgentPolicy): AgentPolicy => JSON.parse(JSON.stringify(p)) as AgentPolicy;

export function validatePolicy(p: AgentPolicy): void {
  const lists = [p.writable, p.protected, p.commands.allow, p.commands.deny];
  if (!lists.every((l) => Array.isArray(l) && l.every((x) => typeof x === "string"))) throw new Error("policy lists must be arrays of strings");
  for (const [k, v] of [["edits", p.edits], ["network", p.network], ["otherwise", p.otherwise]] as const) {
    const allowed = k === "edits" ? ["allow", "ask"] : ["allow", "ask", "deny"];
    if (!allowed.includes(v)) throw new Error(`policy.${k} must be one of ${allowed.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// Globs

const globCache = new Map<string, RegExp>();

/** Glob to RegExp: `**` (any depth, including none), `*`, `?`, `{a,b}`. Paths use `/`. */
export function globToRegExp(glob: string): RegExp {
  const hit = globCache.get(glob);
  if (hit) return hit;
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${glob.slice(i + 1, end).split(",").map(escapeRe).join("|")})`;
        i = end;
      }
    } else re += escapeRe(c);
  }
  const r = new RegExp(`^${re}$`);
  globCache.set(glob, r);
  return r;
}

const escapeRe = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

export function matchesAny(globs: string[], relPath: string): string | undefined {
  const p = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return globs.find((g) => globToRegExp(g).test(p));
}

// ---------------------------------------------------------------------------
// Commands

/** Splits a shell command on operators that chain or pipe commands. */
export function commandParts(command: string): string[] {
  return command
    .split(/\|\||&&|;|\||\n/)
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

function wildcard(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map(escapeRe).join(".*")}$`, "s");
}

const NETWORK_COMMAND = /^(curl|wget|nc|ncat|ssh|scp|rsync|ftp|telnet)\b|^git (push|fetch|pull|clone)\b|^npm (publish|login)\b|^(pip|pip3) install\b/;
const RISKY = /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|\bgit\s+push\b|\bsudo\b|\|\s*(ba|z)?sh\b|\bnpm\s+publish\b|\bdeploy\b|\bkubectl\s+(apply|delete)\b|\bterraform\s+(apply|destroy)\b|\.env\b|id_rsa|\.pem\b|\bmkfs\b|\bdd\s+if=/;

export function isRisky(command: string | undefined): boolean {
  return !!command && RISKY.test(command);
}

export function evaluateCommand(policy: AgentPolicy, command: string): PolicyDecision {
  const whole = command.trim().replace(/\s+/g, " ");
  const parts = commandParts(command);
  for (const pattern of policy.commands.deny) {
    const re = wildcard(pattern);
    if (re.test(whole) || parts.some((p) => re.test(p))) return { decision: "deny", rule: `commands.deny: ${pattern}` };
  }
  // Touching a protected file from the shell (cat .env, cp id_rsa ...).
  for (const token of whole.split(" ")) {
    const t = token.replace(/^['"]|['"]$/g, "");
    const g = t && !t.startsWith("-") ? matchesAny(policy.protected, t) : undefined;
    if (g) return { decision: "deny", rule: `protected: ${g}` };
  }
  if (parts.some((p) => NETWORK_COMMAND.test(p))) {
    if (policy.network === "deny") return { decision: "deny", rule: "network: deny" };
    if (policy.network === "ask") return { decision: "ask", rule: "network: ask" };
  }
  // Substitutions can hide anything: never auto-allow them.
  if (/\$\(|`/.test(command)) return { decision: policy.otherwise === "deny" ? "deny" : "ask", rule: "command substitution" };
  const allowed = parts.length > 0 && parts.every((p) => policy.commands.allow.some((pattern) => wildcard(pattern).test(p)));
  if (allowed) return { decision: "allow", rule: "commands.allow" };
  return { decision: policy.otherwise, rule: "otherwise" };
}

// ---------------------------------------------------------------------------
// Requests

export function evaluatePermission(policy: AgentPolicy, q: PermissionQuery): PolicyDecision {
  const kind = q.toolKind ?? "other";
  if (q.path) {
    const prot = matchesAny(policy.protected, q.path);
    if (prot) return { decision: "deny", rule: `protected: ${prot}` };
  }
  switch (kind) {
    case "read":
    case "search":
      return { decision: "allow", rule: "reads inside the worktree" };
    case "edit":
    case "delete":
    case "move": {
      if (q.path && !matchesAny(policy.writable, q.path)) return { decision: "deny", rule: "outside writable" };
      return policy.edits === "allow" ? { decision: "allow", rule: "edits: allow" } : { decision: "ask", rule: "edits: ask" };
    }
    case "execute":
      return q.command ? evaluateCommand(policy, q.command) : { decision: policy.otherwise, rule: "otherwise (no command given)" };
    case "fetch":
      return { decision: policy.network, rule: `network: ${policy.network}` };
    default:
      if (q.command) return evaluateCommand(policy, q.command);
      return { decision: policy.otherwise, rule: "otherwise" };
  }
}

/** Pulls a command line out of an agent's raw tool input (shapes differ per agent). */
export function commandFromRawInput(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return typeof raw === "string" ? raw : undefined;
  const r = raw as Record<string, unknown>;
  const c = r.command ?? r.cmd ?? r.commandLine;
  if (typeof c === "string") return c;
  if (Array.isArray(c) && c.every((x) => typeof x === "string")) {
    // ["bash", "-lc", "npm test"] → "npm test"
    const arr = c as string[];
    const i = arr.findIndex((x) => x === "-c" || x === "-lc");
    return i >= 0 && arr[i + 1] ? arr[i + 1] : arr.join(" ");
  }
  return undefined;
}

export function pathFromRawInput(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const p = r.file_path ?? r.path ?? r.filePath ?? r.abs_path;
  return typeof p === "string" ? p : undefined;
}

export function urlFromRawInput(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = (raw as Record<string, unknown>).url;
  return typeof u === "string" ? u : undefined;
}
