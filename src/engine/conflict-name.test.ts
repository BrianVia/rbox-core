import { expect, test } from "bun:test";
import { isRboxConflictArtifact } from "./conflict-name.js";

const TS = "20260816041610";

test("the conflict-artifact grammar claims every producer's mint and nothing else", () => {
  const positives = [
    `index.dev_ab12cd34.${TS}.conflict.ts`,
    ".env.dev_aaaa33728fad066416272ae9ffa2b2b8.20260813192500.conflict",
    "node_modules.dev_3225c31.20260729231035.conflict",
    `settings.local.dev_aaaa.${TS}.conflict.json`,
    `.env.dev_x.${TS}.conflict~2`,
    `.env.dev_x.${TS}.conflict~10`,
    `notes.local.${TS}.conflict.md~3`,
    `x.trash.${TS}.conflict.`,
  ];
  const negatives = [
    "my.conflict.ts",
    "a.b.2026081604161.conflict.ts",
    `a.${TS}.conflict.ts`,
    `a.b.${TS}.conflicted.ts`,
    `a.b.${TS}.conflict.ts.bak`,
    "conflict-retention.ts",
    `a.b.${TS}.conflict~`,
    `a.b.${TS}.conflict~02`,
    `a.b.${TS}.conflict~1`,
  ];
  expect(positives.length + negatives.length).toBe(17);
  for (const component of positives) expect([component, isRboxConflictArtifact(component)]).toEqual([component, true]);
  for (const component of negatives) expect([component, isRboxConflictArtifact(component)]).toEqual([component, false]);
});
