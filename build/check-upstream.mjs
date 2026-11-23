#!/usr/bin/env node
// Reports how far the pinned upstream is behind the latest Code - OSS release (risk T1).
// Exit code 3 when lag exceeds the two-week goal. Prints a JSON summary for CI.
import { capture, upstream } from "./lib.mjs";

const pin = upstream();
const out = capture("git", ["ls-remote", "--tags", "--refs", pin.repo, "refs/tags/1.*"]);
if (out.code !== 0) {
  console.error(out.stderr);
  process.exit(1);
}
const tags = out.stdout
  .split("\n")
  .map((l) => l.split("refs/tags/")[1])
  .filter((t) => /^\d+\.\d+\.\d+$/.test(t ?? ""));
const cmp = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};
tags.sort(cmp);
const latest = tags[tags.length - 1];
const behind = tags.filter((t) => cmp(t, pin.tag) > 0);
const lagDays = Math.floor((Date.now() - Date.parse(pin.releasedAt)) / 86_400_000);
const summary = { pinned: pin.tag, latest, behind: behind.length, newer: behind, pinnedReleaseAgeDays: lagDays };
console.log(JSON.stringify(summary, null, 2));
// The pin's age only matters once a newer release exists.
if (behind.length && lagDays > 14) {
  console.error(`upstream lag: ${pin.tag} is behind ${latest}; the goal is to follow each release within two weeks`);
  process.exit(3);
}
