#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { JsonRpcPeer } from "@synapse/protocol";

/**
 * A scripted ACP agent. It speaks ACP v1 on stdio like a real agent but runs
 * steps instead of calling a model, so Synapse can be tested and demoed
 * without LLM cost (risk O2), and recorded sessions can be replayed.
 *
 * A prompt is either JSON `{"steps": [...]}` or plain text. Plain text runs
 * the next turn from `--script <file>` (`{"turns": [{"steps": [...]}]}`), or
 * else echoes the prompt back.
 *
 * Steps:
 *   {"say": "text"}                       agent message
 *   {"think": "text"}                     agent thought
 *   {"plan": ["a", "b"]}                  plan entries
 *   {"write": {"path": "rel", "content": "..."}}
 *   {"edit": {"path": "rel", "find": "x", "replace": "y"}}
 *   {"ask": {"title": "Run npm test?", "kind": "execute"}}   stops the turn if rejected
 *   {"sleep": 100}
 */

type Step =
  | { say: string }
  | { think: string }
  | { plan: string[] }
  | { write: { path: string; content: string } }
  | { edit: { path: string; find: string; replace: string } }
  | { ask: { title: string; kind?: string } }
  | { sleep: number };

interface Script {
  turns: { steps: Step[] }[];
}

const { values } = parseArgs({ options: { script: { type: "string" } }, strict: false });
const script: Script | undefined = typeof values.script === "string" ? JSON.parse(fs.readFileSync(values.script, "utf8")) : undefined;
let turnIndex = 0;

const peer = new JsonRpcPeer(process.stdin, process.stdout, { name: "mock-agent" });
const sessions = new Map<string, { cwd: string; cancelled: boolean }>();
let nextSession = 1;
let nextTool = 1;

peer.onRequest("initialize", () => ({
  protocolVersion: 1,
  agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
  agentInfo: { name: "synapse-mock-agent", version: "0.1.0" },
  authMethods: [],
}));

peer.onRequest("session/new", (p: { cwd: string }) => {
  const sessionId = `mock-${nextSession++}`;
  sessions.set(sessionId, { cwd: p.cwd, cancelled: false });
  return { sessionId };
});

peer.onNotification("session/cancel", (p: { sessionId: string }) => {
  const s = sessions.get(p.sessionId);
  if (s) s.cancelled = true;
});

peer.onRequest("session/prompt", async (p: { sessionId: string; prompt: { type: string; text?: string }[] }) => {
  const session = sessions.get(p.sessionId);
  if (!session) throw new Error(`unknown session ${p.sessionId}`);
  session.cancelled = false;
  const text = p.prompt.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
  const steps = stepsFor(text);
  for (const step of steps) {
    if (session.cancelled) return { stopReason: "cancelled" };
    const ok = await run(p.sessionId, session.cwd, step);
    if (!ok) return { stopReason: "end_turn" };
  }
  return { stopReason: session.cancelled ? "cancelled" : "end_turn" };
});

function stepsFor(text: string): Step[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { steps?: Step[] };
      if (Array.isArray(parsed.steps)) return parsed.steps;
    } catch {
      /* not JSON: fall through */
    }
  }
  if (script && turnIndex < script.turns.length) return script.turns[turnIndex++]!.steps;
  return [{ say: `mock agent received: ${trimmed}` }];
}

const update = (sessionId: string, u: Record<string, unknown>) => peer.notify("session/update", { sessionId, update: u });

async function run(sessionId: string, cwd: string, step: Step): Promise<boolean> {
  if ("say" in step) {
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.say } });
  } else if ("think" in step) {
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: step.think } });
  } else if ("plan" in step) {
    update(sessionId, { sessionUpdate: "plan", entries: step.plan.map((content) => ({ content, status: "pending", priority: "medium" })) });
  } else if ("sleep" in step) {
    await new Promise((r) => setTimeout(r, step.sleep));
  } else if ("write" in step || "edit" in step) {
    const rel = "write" in step ? step.write.path : step.edit.path;
    const abs = path.resolve(cwd, rel);
    const toolCallId = `t${nextTool++}`;
    update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: `Edit ${rel}`, kind: "edit", status: "in_progress", locations: [{ path: abs }] });
    try {
      let content: string;
      if ("write" in step) {
        content = step.write.content;
      } else {
        const current = await peer.request<{ content: string }>("fs/read_text_file", { sessionId, path: abs });
        if (!current.content.includes(step.edit.find)) throw new Error(`text to replace not found in ${rel}`);
        content = current.content.replace(step.edit.find, step.edit.replace);
      }
      await peer.request("fs/write_text_file", { sessionId, path: abs, content });
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
    } catch (err) {
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `edit failed: ${(err as Error).message}` } });
    }
  } else if ("ask" in step) {
    const toolCallId = `t${nextTool++}`;
    update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: step.ask.title, kind: step.ask.kind ?? "execute", status: "pending" });
    const r = await peer.request<{ outcome: { outcome: string; optionId?: string } }>("session/request_permission", {
      sessionId,
      toolCall: { toolCallId, title: step.ask.title, kind: step.ask.kind ?? "execute" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    const allowed = r.outcome.outcome === "selected" && r.outcome.optionId === "allow";
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: allowed ? "completed" : "failed" });
    if (!allowed) {
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "permission denied; stopping" } });
      return false;
    }
  }
  return true;
}

peer.on("close", () => process.exit(0));
