import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../../..");

test("design 130 state-layer BASE construction is routed through the mandatory composer", async () => {
  const config = await fs.readFile(path.join(root, "src/cli/config.ts"), "utf8");
  const syncState = await fs.readFile(path.join(root, "src/cli/sync-state.ts"), "utf8");
  const gitCmd = await fs.readFile(path.join(root, "src/cli/git-cmd.ts"), "utf8");

  expect(config).toContain("composeRepoBase(");
  expect(config).toContain("const current = stateFromRepoRecords(raw, repoRecordsForState(raw));");
  expect(syncState).toContain("const composed = composeRepoBase(");
  expect(syncState).toContain("baseProof: source.repoProofs?.[relPath] ?? migrationRepoBaseProof()");
  expect(gitCmd).toContain("kind: \"manual\"");
  expect(gitCmd).toContain("const composed = composeRepoBase(");
  expect(gitCmd).toContain("baseProof };");
  expect(gitCmd).not.toContain("base: incoming };");

  const forbidden = [
    /\.\.\.\(source\.values\.bases\?\.\[relPath\].*\{\s*base:/,
    /newRecord\.base\s*=\s*transition\.newRecord\.base/,
  ];
  for (const pattern of forbidden) {
    expect(`${config}\n${syncState}`).not.toMatch(pattern);
  }
});

test("design 130 authority switch remains exhaustive and lists the reviewed closed union", async () => {
  const composer = await fs.readFile(path.join(root, "src/cli/sync-git/base-composer.ts"), "utf8");
  for (const kind of [
    "pull-ref-transaction", "pull-carry", "journal-recovery", "publisher-ack", "manual", "p-repair", "migration",
  ]) expect(composer).toContain(`case "${kind}"`);
  expect(composer).toContain("const neverAuthority: never = authority");
});
