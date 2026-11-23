export { SynapseCore, type CoreOptions } from "./core.js";
export { serve, defaultSocketPath, type ServerHandle } from "./server.js";
export { parseSource, languageFor, type ParsedFile, type ParsedSymbol, type CallRef } from "./symbols.js";
export { diffSymbols } from "./ownership.js";
export { detectConflicts } from "./conflicts.js";
export { listPresets } from "./presets.js";
export { loadConfig, type SynapseConfig } from "./config.js";
export * from "@synapse/protocol";
