#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import { parseArgs } from "node:util";
import {
  SynapseClient,
  findRepoRoot,
  readDiscovery,
  type AgentOutputEvent,
  type AgentState,
  type Approval,
  type Conflict,
  type CoreEvent,
  type Review,
} from "@synapse/client";

const HELP = `synapse — direct several AI agents in one workspace

Usage: synapse <command> [options]

Core
  core start [--foreground]          start synapse-core for this repository
  core stop                          stop it
  core status                        show whether it is running

Agents
  presets                            list agent presets
  agent add <preset> [--id ID] [--name NAME] [--color HEX] [--start]
  agent add --command CMD [--arg A]... --id ID
  agent start|stop|restart|remove|reset <id>
  agent prompt <id> <text...> [--wait]
  agent cancel <id>

Coordination
  status                             the collaboration board
  owners [--agent ID]                files and symbols each agent owns
  conflicts [--check]                conflicts between agents
  approvals                          pending approvals
  approve <approval-id> [--option ID]
  reject <approval-id>
  watch                              stream events

Review
  review [--agents a,b] [--no-tests] combine agents' work, test it, show the result
  review diff <review-id> [path]
  review discard <review-id>
  merge <review-id> [--reset-agents] [--force]

Global options: --workspace DIR (default: cwd), --json
`;

const require = createRequire(import.meta.url);
const coreMain = () => require.resolve("@synapse/core/main");

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      workspace: { type: "string", short: "w" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      foreground: { type: "boolean" },
      id: { type: "string" },
      name: { type: "string" },
      color: { type: "string" },
      command: { type: "string" },
      arg: { type: "string", multiple: true },
      start: { type: "boolean" },
      wait: { type: "boolean" },
      agent: { type: "string" },
      agents: { type: "string" },
      check: { type: "boolean" },
      option: { type: "string" },
      "no-tests": { type: "boolean" },
      "reset-agents": { type: "boolean" },
      force: { type: "boolean" },
      "keep-worktree": { type: "boolean" },
    },
  });
  const [cmd, sub, ...rest] = positionals;
  if (values.help || !cmd) {
    process.stdout.write(HELP);
    return cmd ? 0 : 1;
  }
  const workspace = path.resolve(values.workspace ?? process.cwd());
  const json = !!values.json;
  const out = (data: unknown, human: () => string) => process.stdout.write((json ? JSON.stringify(data, null, 2) : human()) + "\n");

  if (cmd === "core") {
    const repoRoot = findRepoRoot(workspace);
    if (!repoRoot) throw new Error("Not inside a git repository");
    if (sub === "start") {
      if (values.foreground) {
        const child = spawn(process.execPath, [coreMain(), "--workspace", repoRoot], { stdio: "inherit" });
        return await new Promise((r) => child.on("exit", (code) => r(code ?? 0)));
      }
      const c = await SynapseClient.connectOrStart({ workspace: repoRoot, coreMain: coreMain(), clientName: "synapse-cli" });
      out(c.hello, () => `synapse-core ${c.hello.version} running for ${c.hello.repoRoot} (pid ${c.hello.pid}, base ${c.hello.baseRef})`);
      c.close();
      return 0;
    }
    if (sub === "stop") {
      const c = await SynapseClient.connect({ workspace, clientName: "synapse-cli" }).catch(() => undefined);
      if (!c) {
        out({ running: false }, () => "synapse-core is not running");
        return 0;
      }
      await c.call("core.shutdown");
      c.close();
      out({ stopped: true }, () => "synapse-core stopped");
      return 0;
    }
    if (sub === "status") {
      const disc = readDiscovery(repoRoot);
      const c = disc ? await SynapseClient.connect({ workspace, clientName: "synapse-cli" }).catch(() => undefined) : undefined;
      out({ running: !!c, ...(c ? c.hello : {}) }, () => (c ? `running: pid ${c.hello.pid}, base ${c.hello.baseRef}, socket ${disc!.socket}` : "not running"));
      c?.close();
      return 0;
    }
    throw new Error(`Unknown: core ${sub ?? ""}`);
  }

  const client = await SynapseClient.connectOrStart({ workspace, coreMain: coreMain(), clientName: "synapse-cli" });
  try {
    return await run(client, cmd, sub, rest, values, out);
  } finally {
    client.close();
  }
}

type Values = Record<string, string | boolean | string[] | undefined>;
type Out = (data: unknown, human: () => string) => void;

async function run(c: SynapseClient, cmd: string, sub: string | undefined, rest: string[], v: Values, out: Out): Promise<number> {
  const need = (x: string | undefined, what: string) => {
    if (!x) throw new Error(`Missing ${what}`);
    return x;
  };
  switch (cmd) {
    case "presets": {
      const presets = await c.call("agents.presets");
      out(presets, () => presets.map((p) => `${p.id.padEnd(8)} ${p.command} ${p.args.join(" ")}\n         ${p.notes}`).join("\n"));
      return 0;
    }
    case "status": {
      const s = await c.call("state.get");
      out(s, () => renderBoard(s.agents, s.conflicts, s.approvals, s.ownership));
      return 0;
    }
    case "agent": {
      const action = need(sub, "agent action");
      if (action === "add") {
        const agent = await c.call("agents.add", {
          preset: rest[0],
          id: v.id as string | undefined,
          name: v.name as string | undefined,
          color: v.color as string | undefined,
          command: v.command as string | undefined,
          args: (v.arg as string[] | undefined) ?? undefined,
          start: !!v.start,
        });
        out(agent, () => `added ${agent.id} (${agent.status}) — worktree ${agent.worktree.path} on ${agent.worktree.branch}`);
        return 0;
      }
      const id = need(rest[0], "agent id");
      if (action === "prompt") {
        const text = need(rest.slice(1).join(" "), "prompt text");
        if (!v.wait) {
          await c.call("agents.prompt", { id, text });
          out({ accepted: true }, () => `prompt sent to ${id}`);
          return 0;
        }
        return await promptAndWait(c, id, text, out);
      }
      const methods = { start: "agents.start", stop: "agents.stop", restart: "agents.restart", reset: "agents.reset" } as const;
      if (action in methods) {
        const a = await c.call(methods[action as keyof typeof methods], { id });
        out(a, () => `${a.id}: ${a.status}${a.error ? ` — ${a.error}` : ""}`);
        return 0;
      }
      if (action === "remove") {
        await c.call("agents.remove", { id, keepWorktree: !!v["keep-worktree"] });
        out({ removed: id }, () => `removed ${id}`);
        return 0;
      }
      if (action === "cancel") {
        await c.call("agents.cancel", { id });
        out({ cancelled: id }, () => `cancel sent to ${id}`);
        return 0;
      }
      throw new Error(`Unknown agent action: ${action}`);
    }
    case "owners": {
      const list = await c.call("ownership.refresh", { agentId: v.agent as string | undefined });
      out(list, () =>
        list
          .map((o) => {
            const lines = o.files.map((f) => {
              const syms = f.symbols.map((s) => `${s.name}${s.change === "modified" ? "" : ` (${s.change})`}${s.signatureChanged ? " [signature]" : ""}`);
              return `  ${f.status.padEnd(8)} ${f.path}  +${f.linesAdded}/-${f.linesRemoved}${syms.length ? `\n             ${syms.join(", ")}` : ""}`;
            });
            return `${o.agentId}:\n${lines.join("\n") || "  (no changes)"}`;
          })
          .join("\n"),
      );
      return 0;
    }
    case "conflicts": {
      const list = v.check ? await c.call("conflicts.check") : await c.call("conflicts.list");
      out(list, () => renderConflicts(list));
      return list.some((x) => x.severity === "error") ? 2 : 0;
    }
    case "approvals": {
      const list = await c.call("approvals.list", {});
      out(list, () => (list.length ? list.map(renderApproval).join("\n") : "no pending approvals"));
      return 0;
    }
    case "approve":
    case "reject": {
      const a = await c.call("approvals.resolve", { id: need(sub, "approval id"), optionId: v.option as string | undefined, reject: cmd === "reject" });
      out(a, () => `${a.id}: ${a.status} (${a.resolution?.optionId ?? "no option"})`);
      return 0;
    }
    case "watch": {
      c.on("event", (ev: CoreEvent) => out(ev, () => renderEvent(ev)));
      await c.subscribe();
      await new Promise<void>((resolve) => c.on("close", () => resolve()));
      return 0;
    }
    case "review": {
      if (sub === "diff") {
        const r = await c.call("review.diff", { id: need(rest[0], "review id"), path: rest[1] });
        process.stdout.write(r.diff + "\n");
        return 0;
      }
      if (sub === "discard") {
        const r = await c.call("review.discard", { id: need(rest[0], "review id") });
        out(r, () => `${r.id}: ${r.status}`);
        return 0;
      }
      if (sub) throw new Error(`Unknown review action: ${sub}`);
      const agents = typeof v.agents === "string" ? v.agents.split(",").map((s) => s.trim()) : undefined;
      const r = await c.call("review.prepare", { agents, runTests: !v["no-tests"] });
      out(r, () => renderReview(r));
      return r.status === "ready" ? 0 : 2;
    }
    case "merge": {
      const r = await c.call("review.merge", { id: need(sub, "review id"), resetAgents: !!v["reset-agents"], force: !!v.force });
      out(r, () => `${r.id}: ${r.status} into ${r.baseRef} at ${r.integrationCommit?.slice(0, 10)}`);
      return 0;
    }
    default:
      throw new Error(`Unknown command: ${cmd}. Run synapse --help.`);
  }
}

async function promptAndWait(c: SynapseClient, id: string, text: string, out: Out): Promise<number> {
  const done = new Promise<number>((resolve) => {
    c.on("event", (ev: CoreEvent) => {
      if (ev.type === "agent.output") {
        const o = ev.data as AgentOutputEvent;
        if (o.agentId !== id) return;
        if (o.kind === "message") process.stderr.write(o.text);
        else if (o.kind === "tool") process.stderr.write(`\n  · ${o.text}\n`);
        else if (o.kind === "turn" && o.text.startsWith("turn ended")) resolve(0);
      } else if (ev.type === "approval.requested") {
        const a = ev.data as Approval;
        if (a.agentId === id) process.stderr.write(`\n  ? approval needed: ${a.title} — run: synapse approve ${a.id}  |  synapse reject ${a.id}\n`);
      } else if (ev.type === "agent.updated") {
        const a = ev.data as AgentState;
        if (a.id === id && (a.status === "stopped" || a.status === "error")) resolve(1);
      }
    });
  });
  await c.subscribe();
  await c.call("agents.prompt", { id, text });
  const code = await done;
  process.stderr.write("\n");
  const agent = (await c.call("agents.list")).find((a) => a.id === id);
  out(agent, () => `${id}: ${agent?.status} (${agent?.turn?.stopReason ?? "?"})`);
  return code;
}

// ---------------------------------------------------------------------------
// Rendering

function renderBoard(agents: AgentState[], conflicts: Conflict[], approvals: Approval[], ownership: Record<string, { files: { path: string; symbols: unknown[] }[] }>): string {
  const lines: string[] = [];
  lines.push(`AGENTS (${agents.length})`);
  for (const a of agents) {
    const files = ownership[a.id]?.files ?? [];
    const symbols = files.reduce((n, f) => n + f.symbols.length, 0);
    lines.push(`  ${a.id.padEnd(12)} ${a.status.padEnd(18)} ${files.length} files, ${symbols} symbols   ${a.worktree.branch}`);
    if (a.turn) lines.push(`  ${"".padEnd(12)} last prompt: ${a.turn.prompt.slice(0, 70)}`);
    if (a.error) lines.push(`  ${"".padEnd(12)} error: ${a.error}`);
  }
  lines.push("", `APPROVALS (${approvals.length})`);
  for (const ap of approvals) lines.push(renderApproval(ap));
  lines.push("", `CONFLICTS (${conflicts.length})`);
  if (conflicts.length) lines.push(renderConflicts(conflicts));
  return lines.join("\n");
}

function renderConflicts(list: Conflict[]): string {
  if (!list.length) return "no conflicts";
  return list.map((c) => `  [${c.severity}] ${c.kind}: ${c.message}`).join("\n");
}

function renderApproval(a: Approval): string {
  return `  ${a.id}  ${a.agentId}: ${a.title}  options: ${a.options.map((o) => `${o.optionId} (${o.kind})`).join(", ")}`;
}

function renderReview(r: Review): string {
  const lines = [`review ${r.id}: ${r.status} — ${r.agents.join(" + ")} onto ${r.baseRef}`];
  if (r.error) lines.push(`  ${r.error}`);
  for (const f of r.files) lines.push(`  ${f.status.padEnd(8)} ${f.path}  +${f.linesAdded}/-${f.linesRemoved}  (${f.agents.join(", ") || "?"})`);
  if (r.mergeConflicts.length) lines.push(`  text conflicts: ${r.mergeConflicts.join(", ")}`);
  if (r.conflicts.length) lines.push("  conflicts:", renderConflicts(r.conflicts));
  if (r.tests) lines.push(`  tests: ${r.tests.passed ? "passed" : "FAILED"} (${r.tests.command}, ${r.tests.durationMs} ms)`);
  if (r.status === "ready") lines.push(`  next: synapse review diff ${r.id}   then   synapse merge ${r.id}`);
  return lines.join("\n");
}

function renderEvent(ev: CoreEvent): string {
  const d = ev.data as Record<string, unknown>;
  switch (ev.type) {
    case "agent.output":
      return `[${d.agentId}] ${d.kind}: ${String(d.text).trimEnd()}`;
    case "agent.updated":
    case "agent.added":
      return `${ev.type} ${d.id}: ${d.status}`;
    case "conflicts.updated":
      return `conflicts: ${(ev.data as Conflict[]).length}`;
    case "ownership.updated":
      return `ownership ${d.agentId}: ${(d.files as unknown[]).length} files`;
    default:
      return `${ev.type} ${JSON.stringify(ev.data).slice(0, 160)}`;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: Error) => {
    process.stderr.write(`synapse: ${err.message}\n`);
    process.exit(1);
  },
);
