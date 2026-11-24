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
  type Task,
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
  agent steer <id> <text...> [--now] guidance while it works: after this turn, or interrupt now
  agent cancel <id>
  diff <agent> [path]                what the agent changed, live (against its base)
  comment add <agent> <path>:<line>[-<end>] <text...> [--tell | --make-task]
                                     comment on its lines; --tell gives it to the agent, --make-task makes a task
  comments [--agent ID]              open comments; comment resolve <id>
  takeover <from> <to> [--task ID] [--note TEXT]
                                     <to> continues <from>'s unfinished work (changes and task move)

Coordination
  status                             the collaboration board
  alerts                             only what needs you now (approvals, conflicts, errors, reviews…)
  team [sync | leave]                teammates' agents via the git remote (team mode: synapse.config.json)
  team adopt <@person/agent> <your-agent> [--note TEXT]
                                     continue a teammate's agent's work with one of yours
  team dismiss <claim-id>            dismiss a teammate's claim on one of your agents
  owners [--agent ID]                files and symbols each agent owns
  conflicts [--check]                conflicts between agents
  approvals                          pending approvals
  approve <approval-id> [--option ID]
  reject <approval-id>
  watch                              stream events

Tasks (the person splits a goal and assigns subtasks)
  tasks                              the task graph
  task add <title> [--agent ID] [--after t-1,t-2] [--scope GLOB,..] [--auto] [--plan-first] [--description TEXT]
  task start|done|fail|review|todo|rm <task-id>
  task plan <task-id> [approve [--plan TEXT] | revise <feedback>]
  goal split <goal> --agent ID       an agent proposes tasks for a goal (changes no files)
  goal show|accept|discard <goal-id> [--auto] [--plan-first]

Messages and decisions
  messages [--agent ID]              structured messages between agents
  message send <agent|all> <subject> [--body TEXT] [--kind handoff|question|answer|note|blocker]
  message release|reject <id>        held (flagged) messages
  decisions                          the shared decision log
  decision add <title> --decision TEXT [--rationale TEXT] [--tags a,b] [--pin path[#Symbol],...]
  decision accept|reject|supersede <id>
  decision pin <id> <path>[#Symbol]  pin to code; flagged when that code changes
  decision unpin <id> <path>[#Symbol]
  decision repin <id>                the decision still holds for the code as it is now

Permissions
  policy <agent>                     show an agent's policy
  policy <agent> --set JSON          change it, e.g. --set '{"network":"deny"}'
  policy <agent> --try CMD           what the policy decides for a command
  audit [--agent ID] [--limit N]     what agents ran, and who allowed it


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
      now: { type: "boolean" },
      tell: { type: "boolean" },
      "make-task": { type: "boolean" },
      note: { type: "string" },
      task: { type: "string" },
      agent: { type: "string" },
      agents: { type: "string" },
      check: { type: "boolean" },
      try: { type: "string" },
      option: { type: "string" },
      "no-tests": { type: "boolean" },
      "reset-agents": { type: "boolean" },
      force: { type: "boolean" },
      "keep-worktree": { type: "boolean" },
      description: { type: "string" },
      after: { type: "string" },
      scope: { type: "string" },
      auto: { type: "boolean" },
      kind: { type: "string" },
      body: { type: "string" },
      decision: { type: "string" },
      pin: { type: "string" },
      rationale: { type: "string" },
      tags: { type: "string" },
      set: { type: "string" },
      limit: { type: "string" },
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
      if (action === "steer") {
        const a = await c.call("agents.steer", { id, text: need(rest.slice(1).join(" "), "guidance"), mode: v.now ? "now" : "next" });
        out(a, () => (a.guidance?.length ? `${a.id}: ${a.guidance.length} guidance item(s) ${v.now ? "now (interrupting)" : "after this turn"}` : `${a.id} was idle: sent as a prompt`));
        return 0;
      }
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
    case "goal": {
      const action = need(sub, "goal action");
      if (action === "split") {
        const g = await c.call("goals.split", { goal: need(rest.join(" "), "goal"), agentId: need(v.agent as string | undefined, "--agent") });
        out(g, () => `${g.id}: ${g.agentId} is splitting the goal; see it with: synapse goal show ${g.id}`);
        return 0;
      }
      const id = need(rest[0], "goal id");
      if (action === "accept") {
        const tasks = await c.call("goals.accept", { id, autoStart: !!v.auto, planFirst: !!v["plan-first"] });
        out(tasks, () => tasks.map((t) => `added ${t.id}: ${t.title}${t.agentId ? ` → ${t.agentId}` : ""}${t.dependsOn.length ? ` (after ${t.dependsOn.join(", ")})` : ""}`).join("\n"));
        return 0;
      }
      if (action === "discard") {
        const g = await c.call("goals.discard", { id });
        out(g, () => `${g.id}: discarded`);
        return 0;
      }
      const g = (await c.call("state.get")).goals.find((x) => x.id === id);
      if (!g) throw new Error(`No goal ${id}`);
      out(g, () => [`${g.id} (${g.status}): ${g.goal}`, ...g.tasks.map((t) => `  [${t.key}] ${t.title}${t.agentId ? ` → ${t.agentId}` : ""}${t.dependsOn.length ? ` (after ${t.dependsOn.join(", ")})` : ""}`), g.error ? `  error: ${g.error}` : ""].filter(Boolean).join("\n"));
      return 0;
    }
    case "tasks": {
      const list = await c.call("tasks.list");
      out(list, () => renderTasks(list));
      return 0;
    }
    case "task": {
      const action = need(sub, "task action");
      const csv = (x: unknown) => (typeof x === "string" && x ? x.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
      if (action === "add") {
        const t = await c.call("tasks.create", {
          title: need(rest.join(" "), "task title"),
          description: v.description as string | undefined,
          agentId: v.agent as string | undefined,
          dependsOn: csv(v.after),
          scope: csv(v.scope),
          autoStart: !!v.auto,
          planFirst: v["plan-first"] ? true : undefined,
        });
        out(t, () => `added ${t.id}: ${t.title}${t.blocked ? " (blocked)" : ""}`);
        return 0;
      }
      const id = need(rest[0], "task id");
      if (action === "plan") {
        const verb = rest[1];
        if (verb === "approve") {
          const x = await c.call("tasks.approvePlan", { id, plan: v.plan as string | undefined });
          out(x, () => `${x.id}: plan approved, ${x.agentId} carries it out`);
          return 0;
        }
        if (verb === "revise") {
          const x = await c.call("tasks.revisePlan", { id, feedback: need(rest.slice(2).join(" "), "feedback") });
          out(x, () => `${x.id}: plan sent back to ${x.agentId}`);
          return 0;
        }
        const x = (await c.call("tasks.list")).find((y) => y.id === id);
        if (!x) throw new Error(`No task ${id}`);
        out(x.plan ?? null, () => (x.plan ? `${x.id} plan (${x.plan.state}, round ${x.plan.rounds}):\n${x.plan.text ?? "(being written)"}` : `${x.id} has no plan${x.planFirst ? " yet" : " (not plan-first)"}`));
        return 0;
      }
      if (action === "rm") {
        await c.call("tasks.remove", { id });
        out({ removed: id }, () => `removed ${id}`);
        return 0;
      }
      const status = { start: "in_progress", done: "done", fail: "failed", review: "review", todo: "todo" }[action];
      if (!status) throw new Error(`Unknown task action: ${action}`);
      const t = action === "start" ? await c.call("tasks.start", { id }) : await c.call("tasks.setStatus", { id, status: status as "done" });
      out(t, () => `${t.id}: ${t.status}`);
      return 0;
    }
    case "messages": {
      const list = await c.call("messages.list", { agentId: v.agent as string | undefined });
      out(list, () =>
        list.length
          ? list.map((m) => `  ${m.id}  [${m.status}${m.flags.length ? `: ${m.flags.join(",")}` : ""}] ${m.kind} ${m.from} → ${m.to}: ${m.subject}${m.body ? `\n      ${m.body.slice(0, 200).replace(/\n/g, " ")}` : ""}`).join("\n")
          : "no messages",
      );
      return 0;
    }
    case "message": {
      const action = need(sub, "message action");
      if (action === "send") {
        const m = await c.call("messages.send", {
          to: need(rest[0], "recipient"),
          subject: need(rest.slice(1).join(" "), "subject"),
          body: v.body as string | undefined,
          kind: v.kind as "note" | undefined,
        });
        out(m, () => `${m.id}: ${m.status}`);
        return 0;
      }
      const id = need(rest[0], "message id");
      const m = action === "release" ? await c.call("messages.release", { id }) : action === "reject" ? await c.call("messages.reject", { id }) : undefined;
      if (!m) throw new Error(`Unknown message action: ${action}`);
      out(m, () => `${m.id}: ${m.status}`);
      return 0;
    }
    case "team": {
      if (sub === "adopt") {
        const r = await c.call("team.adopt", { from: need(rest[0], "teammate's agent (@person/agent)"), to: need(rest[1], "your agent"), note: v.note as string | undefined });
        out(r, () => `${r.to.id} continues ${rest[0]}${r.task ? ` as ${r.task.id}` : ""}: ${r.files.length} file(s)`);
        return 0;
      }
      const t =
        sub === "sync" ? await c.call("team.sync") : sub === "leave" ? await c.call("team.leave") : sub === "dismiss" ? await c.call("team.dismissClaim", { id: need(rest[0], "claim id") }) : await c.call("team.status");
      out(t, () => {
        if (!t.enabled) return 'team mode is off; enable it with "team": { "enabled": true } in synapse.config.json';
        const lines = [`you are "${t.person}" (${t.role}) on ${t.remote}${t.lastSync ? `, last sync ${t.lastSync}` : ""}${t.error ? `\n  error: ${t.error}` : ""}`];
        for (const cl of t.claimsOnMe) lines.push(`  ! ${cl.by} continued ${cl.agent}'s work in their ${cl.byAgent} (dismiss: team dismiss ${cl.id})`);
        if (!t.peers.length) lines.push("  no teammates yet");
        for (const p of t.peers) {
          lines.push(`  ${p.person}${p.stale ? " (not updated recently)" : ""}`);
          for (const a of p.agents) lines.push(`    ${a.id.padEnd(24)} ${a.status.padEnd(10)} ${a.task ?? ""}${a.files.length ? `  ${a.files.length} file(s)` : ""}${a.claimedBy ? `  (continued by ${a.claimedBy})` : ""}`);
        }
        return lines.join("\n");
      });
      return 0;
    }
    case "alerts": {
      const { alerts } = await c.call("state.get");
      out(alerts, () =>
        alerts.length
          ? alerts.map((a) => `  ${a.level === "urgent" ? "!!" : " •"} ${a.title}${a.detail ? `\n      ${a.detail.split("\n")[0]!.slice(0, 160)}` : ""}`).join("\n")
          : "nothing needs you right now",
      );
      return 0;
    }
    case "diff": {
      const d = await c.call("agents.diff", { id: need(sub, "agent id"), path: rest[0] });
      out(d, () => {
        if (!d.files.length) return `${d.agentId} has no changes against ${d.baseCommit.slice(0, 8)}`;
        const lines: string[] = [];
        for (const f of d.files) {
          lines.push(`\n${f.status === "added" ? "A" : f.status === "deleted" ? "D" : "M"} ${f.path}${f.binary ? " (binary)" : ""}${f.truncated ? " (truncated)" : ""}`);
          for (const hk of f.hunks) {
            lines.push(`@@ -${hk.oldStart},${hk.oldLines} +${hk.newStart},${hk.newLines} @@ ${hk.header}`);
            for (const l of hk.lines) lines.push(`${l.t === " " ? " " : l.t}${String(l.newNo ?? l.oldNo ?? "").padStart(5)} ${l.text}`);
          }
        }
        return lines.join("\n").trimStart();
      });
      return 0;
    }
    case "comments": {
      const list = (await c.call("comments.list", { agentId: v.agent as string | undefined })).filter((x) => x.status === "open");
      out(list, () =>
        list.length
          ? list.map((x) => `  ${x.id}  ${x.agentId}  ${x.path}:${x.line}${x.endLine > x.line ? `-${x.endLine}` : ""}  [${x.action}${x.taskId ? ` ${x.taskId}` : ""}]${x.outdated ? " (outdated)" : ""}  ${x.text.split("\n")[0]}`).join("\n")
          : "no open comments",
      );
      return 0;
    }
    case "comment": {
      const action = need(sub, "comment action");
      if (action === "resolve") {
        const x = await c.call("comments.resolve", { id: need(rest[0], "comment id") });
        out(x, () => `${x.id}: ${x.status}`);
        return 0;
      }
      if (action !== "add") throw new Error(`Unknown comment action: ${action}`);
      const where = /^(.+):(\d+)(?:-(\d+))?$/.exec(need(rest[1], "path:line"));
      if (!where) throw new Error("Give the place as path:line or path:line-end");
      const x = await c.call("comments.add", {
        agentId: need(rest[0], "agent id"),
        path: where[1]!,
        line: Number(where[2]),
        endLine: where[3] ? Number(where[3]) : undefined,
        text: need(rest.slice(2).join(" "), "comment text"),
        action: v.tell ? "guidance" : v["make-task"] ? "task" : "note",
      });
      out(x, () => `${x.id}: ${x.action === "guidance" ? "given to the agent" : x.action === "task" ? `task ${x.taskId} created` : "noted"} at ${x.path}:${x.line}`);
      return 0;
    }
    case "takeover": {
      const r = await c.call("agents.takeover", { from: need(sub, "from agent"), to: need(rest[0], "to agent"), taskId: v.task as string | undefined, note: v.note as string | undefined });
      out(r, () => `${r.to.id} took over ${r.task ? `${r.task.id} (${r.task.title})` : "the request"} from ${r.from?.id}: ${r.files.length} file(s) moved, kept at ${r.commit.slice(0, 10)}`);
      return 0;
    }
    case "decisions": {
      const list = await c.call("decisions.list");
      const mark = { current: "", changed: "  ⚠ code changed", missing: "  ⚠ gone from base" };
      const line = (d: (typeof list)[number]) =>
        [
          `  ${d.id.padEnd(5)} [${d.status}] ${d.title}: ${d.decision}${d.author !== "human" ? `  (by ${d.author})` : ""}`,
          ...(d.anchors ?? []).map((a) => `        pinned: ${a.path}${a.symbol ? `#${a.symbol}` : ""}${mark[a.state]}`),
        ].join("\n");
      out(list, () => (list.length ? list.map(line).join("\n") : "no decisions"));
      return 0;
    }
    case "decision": {
      const action = need(sub, "decision action");
      if (action === "add") {
        const d = await c.call("decisions.add", {
          title: need(rest.join(" "), "title"),
          decision: need(v.decision as string | undefined, "--decision"),
          rationale: v.rationale as string | undefined,
          tags: typeof v.tags === "string" ? v.tags.split(",") : undefined,
          pins: typeof v.pin === "string" ? v.pin.split(",").map(pinSpec) : undefined,
        });
        out(d, () => `${d.id}: ${d.status}${d.anchors?.length ? `, pinned to ${d.anchors.length} place(s)` : ""}`);
        return 0;
      }
      if (action === "pin" || action === "unpin") {
        const pin = pinSpec(need(rest[1], "path[#Symbol]"));
        const d = await c.call(action === "pin" ? "decisions.pin" : "decisions.unpin", { id: need(rest[0], "decision id"), ...pin });
        out(d, () => `${d.id}: ${action === "pin" ? "pinned to" : "unpinned from"} ${pin.path}${pin.symbol ? `#${pin.symbol}` : ""}`);
        return 0;
      }
      if (action === "repin") {
        const d = await c.call("decisions.repin", { id: need(rest[0], "decision id") });
        out(d, () => `${d.id}: confirmed for the code on the base branch now (${d.anchors?.length ?? 0} pin(s))`);
        return 0;
      }
      const status = { accept: "accepted", reject: "rejected", supersede: "superseded" }[action] as "accepted" | undefined;
      if (!status) throw new Error(`Unknown decision action: ${action}`);
      const d = await c.call("decisions.resolve", { id: need(rest[0], "decision id"), status });
      out(d, () => `${d.id}: ${d.status}`);
      return 0;
    }
    case "policy": {
      const id = need(sub, "agent id");
      if (typeof v.try === "string") {
        const r = await c.call("policy.evaluate", { agentId: id, query: { toolKind: "execute", command: v.try } });
        out(r, () => `${r.decision} (${r.rule})`);
        return 0;
      }
      if (typeof v.set === "string") {
        const a = await c.call("agents.setPolicy", { id, policy: JSON.parse(v.set) });
        out(a.policy, () => JSON.stringify(a.policy, null, 2));
        return 0;
      }
      const a = (await c.call("agents.list")).find((x) => x.id === id);
      if (!a) throw new Error(`No agent "${id}"`);
      out(a.policy, () => JSON.stringify(a.policy, null, 2));
      return 0;
    }
    case "audit": {
      const list = await c.call("audit.list", { agentId: v.agent as string | undefined, limit: v.limit ? Number(v.limit) : undefined });
      out(list, () =>
        list.length
          ? list.map((e) => `  ${e.at.slice(11, 19)} ${e.agentId.padEnd(8)} ${e.outcome.padEnd(11)} by ${e.by.padEnd(6)} ${e.risky ? "RISKY " : ""}${e.command ?? e.path ?? e.title}${e.rule ? `  (${e.rule})` : ""}`).join("\n")
          : "audit log is empty",
      );
      return 0;
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

function renderTasks(list: Task[]): string {
  if (!list.length) return "no tasks";
  return list
    .map((t) => {
      const deps = t.dependsOn.length ? ` after ${t.dependsOn.join(",")}` : "";
      const flags = [t.blocked ? "blocked" : "", t.autoStart ? "auto" : "", t.outOfScope?.length ? `out of scope: ${t.outOfScope.join(",")}` : ""].filter(Boolean).join("; ");
      return `  ${t.id.padEnd(5)} ${t.status.padEnd(11)} ${(t.agentId ?? "-").padEnd(10)} ${t.title}${deps}${flags ? `  [${flags}]` : ""}`;
    })
    .join("\n");
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

/** "path" or "path#Symbol". */
function pinSpec(spec: string): { path: string; symbol?: string } {
  const at = spec.lastIndexOf("#");
  return at > 0 ? { path: spec.slice(0, at), symbol: spec.slice(at + 1) } : { path: spec };
}
