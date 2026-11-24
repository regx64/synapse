#!/usr/bin/env node
import { spawn } from "node:child_process";
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
 *   {"run": {"command": "npm test", "title": "Run tests"}}   asks permission like a real agent, then reports
 *   {"mcp": {"tool": "synapse_send_message", "args": {...}}}  calls a tool on the session's MCP server
 */

type Step =
  | { say: string }
  | { think: string }
  | { plan: string[] }
  | { write: { path: string; content: string } }
  | { edit: { path: string; find: string; replace: string } }
  | { ask: { title: string; kind?: string } }
  | { sleep: number }
  | { run: { command: string; title?: string; ask?: boolean } }
  | { mcp: { server?: string; tool: string; args?: Record<string, unknown> } };

interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env?: { name: string; value: string }[];
}

interface Script {
  turns: { steps: Step[] }[];
}

const { values } = parseArgs({ options: { script: { type: "string" } }, strict: false });
const script: Script | undefined = typeof values.script === "string" ? JSON.parse(fs.readFileSync(values.script, "utf8")) : undefined;
let turnIndex = 0;

const peer = new JsonRpcPeer(process.stdin, process.stdout, { name: "mock-agent" });
const sessions = new Map<string, { cwd: string; cancelled: boolean; mcpServers: McpServerSpec[] }>();
const mcpClients = new Map<string, Promise<JsonRpcPeer>>();
let nextSession = 1;
let nextTool = 1;

peer.onRequest("initialize", () => ({
  protocolVersion: 1,
  agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
  agentInfo: { name: "synapse-mock-agent", version: "0.1.0" },
  authMethods: [],
}));

peer.onRequest("session/new", (p: { cwd: string; mcpServers?: McpServerSpec[] }) => {
  const sessionId = `mock-${nextSession++}`;
  sessions.set(sessionId, { cwd: p.cwd, cancelled: false, mcpServers: p.mcpServers ?? [] });
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
    const ok = await run(p.sessionId, session.cwd, step, session.mcpServers);
    if (!ok) return { stopReason: "end_turn" };
  }
  return { stopReason: session.cancelled ? "cancelled" : "end_turn" };
});

function stepsFor(text: string): Step[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      // Steps are on the first line; Synapse may append its context block below.
      const parsed = JSON.parse(trimmed.split("\n")[0]!) as { steps?: Step[] };
      if (Array.isArray(parsed.steps)) return parsed.steps;
    } catch {
      /* not JSON: fall through */
    }
  }
  if (script && turnIndex < script.turns.length) return script.turns[turnIndex++]!.steps;
  return [{ say: `mock agent received: ${trimmed}` }];
}

const update = (sessionId: string, u: Record<string, unknown>) => {
  // Each scripted message is a separate paragraph (real agents stream one continuous text).
  const content = u.content as { type?: string; text?: string } | undefined;
  if (u.sessionUpdate === "agent_message_chunk" && content?.type === "text" && content.text && !content.text.endsWith("\n")) {
    u = { ...u, content: { ...content, text: `${content.text}\n` } };
  }
  peer.notify("session/update", { sessionId, update: u });
};

function mcpClient(spec: McpServerSpec): Promise<JsonRpcPeer> {
  let p = mcpClients.get(spec.name);
  if (!p) {
    p = (async () => {
      const env = { ...process.env };
      for (const e of spec.env ?? []) env[e.name] = e.value;
      const child = spawn(spec.command, spec.args, { env, stdio: ["pipe", "pipe", "inherit"] });
      const client = new JsonRpcPeer(child.stdout, child.stdin, { name: `mcp:${spec.name}`, timeoutMs: 30_000 });
      await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "synapse-mock-agent", version: "0.1.0" } });
      client.notify("notifications/initialized");
      return client;
    })();
    mcpClients.set(spec.name, p);
  }
  return p;
}

async function run(sessionId: string, cwd: string, step: Step, mcpServers: McpServerSpec[] = []): Promise<boolean> {
  if ("mcp" in step) {
    const spec = mcpServers.find((s) => s.name === (step.mcp.server ?? "synapse"));
    const toolCallId = `t${nextTool++}`;
    update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: `MCP ${step.mcp.tool}`, kind: "other", status: "in_progress" });
    if (!spec) {
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "no MCP server named " + (step.mcp.server ?? "synapse") } });
      return true;
    }
    const client = await mcpClient(spec);
    const r = await client.request<{ content: { type: string; text?: string }[]; isError?: boolean }>("tools/call", { name: step.mcp.tool, arguments: step.mcp.args ?? {} });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: r.isError ? "failed" : "completed" });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: r.content.map((c) => c.text ?? "").join("\n") } });
    return true;
  }
  if ("run" in step) {
    const toolCallId = `t${nextTool++}`;
    const rawInput = { command: step.run.command };
    update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: step.run.title ?? step.run.command, kind: "execute", status: "pending", rawInput });
    if (step.run.ask !== false) {
      const r = await peer.request<{ outcome: { outcome: string; optionId?: string } }>("session/request_permission", {
        sessionId,
        toolCall: { toolCallId, title: step.run.title ?? step.run.command, kind: "execute", rawInput },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      if (!(r.outcome.outcome === "selected" && r.outcome.optionId === "allow")) {
        update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
        update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `not allowed to run: ${step.run.command}` } });
        return true;
      }
    }
    // The mock never executes anything; it only reports that it "ran".
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `ran: ${step.run.command}` } });
    return true;
  }
  if ("say" in step) {
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.say } });
  } else if ("think" in step) {
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: step.think } });
  } else if ("plan" in step) {
    update(sessionId, { sessionUpdate: "plan", entries: step.plan.map((content) => ({ content, status: "pending", priority: "medium" })) });
  } else if ("sleep" in step) {
    // Like a real agent, stop waiting as soon as the turn is cancelled.
    const until = Date.now() + step.sleep;
    while (Date.now() < until && !sessions.get(sessionId)?.cancelled) await new Promise((r) => setTimeout(r, Math.min(50, until - Date.now())));
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
