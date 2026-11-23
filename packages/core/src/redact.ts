import * as os from "node:os";

/**
 * Masks secrets in text that leaves the process or lands on disk: the core
 * log, agent stderr shown on the board, audit entries, crash reports
 * (risk C4).
 */

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
  /(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /(\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*\s*[=:]\s*)["']?[^\s"']{6,}/gi,
];

const extraSecrets = new Set<string>();

/** Registers an exact value to mask everywhere (agent env values, the core token). */
export function addSecret(value: string | undefined): void {
  if (value && value.length >= 8) extraSecrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const s of extraSecrets) out = out.split(s).join("«redacted»");
  for (const re of PATTERNS) {
    out = out.replace(re, (match, prefix: unknown) => (typeof prefix === "string" && match.startsWith(prefix) && prefix !== match ? `${prefix}«redacted»` : "«redacted»"));
  }
  return out;
}

/** Redacts and replaces the home directory, for crash reports. */
export function scrubForReport(text: string): string {
  const home = os.homedir();
  return redact(home ? text.split(home).join("~") : text);
}
