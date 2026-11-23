import { createRequire } from "node:module";
import * as path from "node:path";
import type { PresetInfo } from "@synapse/protocol";
import type { SynapseConfig } from "./config.js";

/**
 * Agent presets. Versions are pinned on purpose (risk T3): bump them together
 * with the nightly compatibility test, not implicitly.
 *
 * Only official ACP paths are used (risk L5): each adapter runs the vendor's
 * own agent under the user's own login or API key. Synapse never pays for or
 * proxies model usage.
 */
const BUILTIN: PresetInfo[] = [
  {
    id: "claude",
    name: "Claude",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.109.1"],
    color: "#d97757",
    notes: "Claude Code through its ACP adapter. Uses your Claude subscription login or ANTHROPIC_API_KEY.",
  },
  {
    id: "codex",
    name: "Codex",
    command: "npx",
    args: ["-y", "@zed-industries/codex-acp@0.16.0"],
    color: "#10a37f",
    notes: "Codex CLI through its ACP adapter. Uses your ChatGPT login or OPENAI_API_KEY.",
  },
  {
    id: "gemini",
    name: "Gemini",
    command: "gemini",
    args: ["--experimental-acp"],
    color: "#4285f4",
    notes: "Gemini CLI in ACP mode (needs `gemini` on PATH). Not part of the MVP: a third agent is out of scope until G2.",
  },
];

function mockPreset(): PresetInfo | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("@synapse/mock-agent/package.json");
    return {
      id: "mock",
      name: "Mock",
      command: process.execPath,
      args: [path.join(path.dirname(pkg), "dist", "src", "main.js")],
      color: "#a855f7",
      notes: "Scripted ACP agent for tests and demos. Replays steps; never calls a model.",
    };
  } catch {
    return undefined;
  }
}

export function listPresets(config: SynapseConfig): PresetInfo[] {
  const all = [...BUILTIN];
  const mock = mockPreset();
  if (mock) all.push(mock);
  return all.map((p) => {
    const o = config.presets?.[p.id];
    return o ? { ...p, ...o, args: o.args ?? p.args } : p;
  });
}
