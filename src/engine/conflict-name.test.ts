import { expect, test } from "bun:test";
import { countConflictCopies, isRboxConflictArtifact } from "./conflict-name.js";

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

test("the count is minted OBJECTS, not the files that happen to sit under them", () => {
  const dir = `node_modules.dev_x.${TS}.conflict`;
  const dirBlast = [`${dir}/a.js`, `${dir}/nested/b.js`, `${dir}/nested/c.js`].map((path) => ({ path }));
  // One directory rbox moved aside is one thing the user inspects and deletes.
  expect(countConflictCopies(dirBlast)).toBe(1);

  // A whole repo living under a conflict-named ANCESTOR contributes that ancestor
  // once — the shallowest matching component names the mint.
  const anc = `anc.dev_x.${TS}.conflict`;
  expect(countConflictCopies([
    { path: `${anc}/repo/src/index.ts` },
    { path: `${anc}/repo/README.md` },
    { path: `${anc}/repo/deep.dev_y.${TS}.conflict.ts` },
  ])).toBe(1);

  // Individually minted files each count, and untouched files never do.
  expect(countConflictCopies([
    { path: "src/index.ts" },
    { path: `src/index.dev_x.${TS}.conflict.ts` },
    { path: `src/other.dev_x.${TS}.conflict.ts` },
    { path: `pkg/${dir}/a.js` },
  ])).toBe(3);

  expect(countConflictCopies([])).toBe(0);
  expect(countConflictCopies([{ path: "my.conflict.ts" }])).toBe(0);
});
