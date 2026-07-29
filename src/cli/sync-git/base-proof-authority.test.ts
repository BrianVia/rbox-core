/**
 * Ordinary state writes may not borrow migration authority.
 *
 * `migration` is a blanket BASE authority: it accepts any candidate refs without
 * a witness. The store seam reserves it for the tagged importer, so every
 * ordinary producer must either supply its own purpose-bound proof or be
 * changing nothing at all. Before this contract existed, a missing
 * `repoProofs` entry silently defaulted to `migrationRepoBaseProof()` in three
 * places on the live JSON write path.
 *
 * Two layers hold it. The compiler owns construction — `MigrationBaseAuthority`
 * is branded, pinned by `migration-authority-surface.typecheck.ts`. This file
 * owns behavior: what the seams do with a proof they are handed, and proof that
 * carry authority composes byte-identically to the default it replaced.
 */
import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GitSection } from "../../engine/index.js";
import { ProoflessBaseError } from "../state-plane/errors.js";
import { applyStateSavePacket } from "../config.js";
import { composeStateSavePacket, savePublishedRepoIntent, type StateSource } from "../sync-state.js";
import { carryRepoBaseProof, composeRepoBase, observedLandingRepoBaseProof, type BranchBaseOrigin, type RepoBaseProof } from "./base-composer.js";
import { migrationRepoBaseProof } from "../state-plane/migration/base-proof.js";

const T = "1".repeat(40);
const U = "2".repeat(40);
const LIN = "a".repeat(64);
const EPISODE = "e".repeat(32);

const section = (head: string): GitSection => ({
  bundleSha: "0".repeat(64), bundleEncSha: "1".repeat(64), bundleCipherSize: 1,
  head: "ref: refs/heads/main", refs: { "refs/heads/main": head }, refScope: "all", generatedAt: "g",
});

const origin: BranchBaseOrigin = { v: 1, oid: T, lineageHash: LIN, kind: "pull-p", episode: EPISODE };

const state = () => ({
  stream: "s", stateNonce: "0".repeat(32), stateRevision: 1, lastSyncedSequence: 1,
  lastSyncedManifest: { generatedAt: "old", files: [] },
  repoRecords: { r: { repoGen: 3, sourceSeq: 1, base: section(T), branchBaseOrigins: { "refs/heads/main": origin } } },
// eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

const source = (values: StateSource["values"], repoProofs?: StateSource["repoProofs"]): StateSource => ({
  expectedStream: "s", sourceGlobalSeq: 2, observedRepos: ["r"], values,
  ...(repoProofs ? { repoProofs } : {}),
});

test("a proofless candidate BASE move is held by carry authority, never laundered as a migration", () => {
  // The packet composer works from a snapshot that may already be stale, so it
  // degrades to the weakest authority rather than refusing a possible race.
  // Carry holds the move: the changed head never reaches the candidate record.
  const packet = composeStateSavePacket(state(), source({ bases: { r: section(U) } }));
  expect(packet.repos[0]?.baseProof?.authority.kind).toBe("pull-carry");
  expect(packet.repos[0]?.newRecord.base?.refs["refs/heads/main"]).toBe(T);
  expect(packet.repos[0]?.newRecord.pending).toEqual(section(U));
});

test("an identical section derives carry authority from the retained lineage", () => {
  const packet = composeStateSavePacket(state(), source({ bases: { r: section(T) } }));
  expect(packet.repos[0]?.baseProof).toEqual(carryRepoBaseProof(LIN));
  expect(packet.repos[0]?.newRecord.base).toEqual(section(T));
  expect(packet.repos[0]?.newRecord.branchBaseOrigins?.["refs/heads/main"]).toMatchObject({ kind: "pull-p" });
});

/**
 * The distinct, and much more common, legitimate case: apply.ts's unchanged
 * shortcut advances a section across scopes and re-bundles it while every
 * governed ref stays put ("unchanged → base advances (possibly across scopes)").
 * This is what `authorityGovernedRefs` exists to permit, and the case where a
 * whole-section equality rule would have wrongly refused live pull traffic.
 */
test("a governed-identical metadata advance composes byte-identically to the pre-HEAD migration default", () => {
  const advanced: GitSection = {
    ...section(T),
    bundleSha: "9".repeat(64), bundleEncSha: "8".repeat(64), bundleCipherSize: 4096,
    refScope: "scoped", generatedAt: "advanced",
  };
  const packet = composeStateSavePacket(state(), source({ bases: { r: advanced } }));
  expect(packet.repos[0]?.baseProof?.authority.kind).toBe("pull-carry");

  // The pre-HEAD path fed these exact inputs to composeRepoBase under the
  // implicit blanket-migration default. Same inputs, that authority, asserted
  // byte-for-byte — so compatibility is proven against the old semantics rather
  // than against a second current implementation.
  const legacy = migrationRepoBaseProof();
  const preHead = composeRepoBase(
    { base: section(T), branchBaseOrigins: { "refs/heads/main": origin } },
    { base: advanced },
    legacy.authority,
    legacy.lockedProof,
  );
  expect(packet.repos[0]?.newRecord.base).toEqual(preHead.base);
  expect(packet.repos[0]?.newRecord.branchBaseOrigins).toEqual(preHead.branchBaseOrigins);

  // ...and the advance is real: the non-governed fields moved, no hold was taken.
  expect(preHead.disposition).toBe("terminal");
  expect(packet.repos[0]?.newRecord.base).toMatchObject({
    bundleSha: "9".repeat(64), refScope: "scoped", generatedAt: "advanced",
    refs: { "refs/heads/main": T },
  });
  expect(packet.repos[0]?.newRecord.pending).toBeUndefined();
});

test("the JSON CAS accepts and persists a governed-identical metadata advance", async () => {
  const advanced: GitSection = { ...section(T), bundleSha: "9".repeat(64), refScope: "scoped", generatedAt: "advanced" };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-base-proof-advance-"));
  try {
    await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
    await fs.writeFile(path.join(root, ".rbox", "state.json"), JSON.stringify(state()));
    const result = await applyStateSavePacket(root, composeStateSavePacket(state(), source({ bases: { r: advanced } })));
    expect(result.status).toBe("accepted");
    const record = result.status === "accepted" ? result.state.repoRecords?.r : undefined;
    expect(record?.base).toMatchObject({ bundleSha: "9".repeat(64), refScope: "scoped", generatedAt: "advanced" });
    expect(record?.base?.refs).toEqual({ "refs/heads/main": T });
    expect(record?.branchBaseOrigins?.["refs/heads/main"]).toMatchObject({ kind: "pull-p" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an unobserved repo (no candidate BASE) derives carry authority and retains its record", () => {
  const packet = composeStateSavePacket(state(), source({}));
  expect(packet.repos[0]?.baseProof).toEqual(carryRepoBaseProof(LIN));
  expect(packet.repos[0]?.newRecord.base).toEqual(section(T));
});

test("a supplied purpose-bound proof is used exactly as given", () => {
  const supplied = carryRepoBaseProof(LIN);
  const packet = composeStateSavePacket(state(), source({ bases: { r: section(T) } }, { r: supplied }));
  expect(packet.repos[0]?.baseProof).toBe(supplied);
});

test("inventory: no ordinary StateSavePacket transition carries migration authority", () => {
  const sources: StateSource[] = [
    source({}),
    source({ bases: { r: section(T) } }),
    source({ bases: { r: section(T) } }, { r: carryRepoBaseProof(LIN) }),
    source({ bases: { r: section(U) } }, { r: carryRepoBaseProof(LIN) }),
    source({ pending: { r: section(U) } }),
    source({ removed: { r: "gone" } }),
    source({ resolutions: { r: "conflict" } }),
    source({ idxProj: { r: "proj" } }),
    { ...source({}), sourceGlobalSeq: 0 }, // stale-source retention path
  ];
  for (const candidate of sources) {
    for (const transition of composeStateSavePacket(state(), candidate).repos) {
      expect(transition.baseProof?.authority.kind, `source ${JSON.stringify(candidate.values)}`)
        .not.toBe("migration");
    }
  }
});

test("the JSON CAS refuses a prooflessly changed BASE instead of defaulting to migration authority", async () => {
  // Under the state lock the predecessor is a fact, not a race, so a proofless
  // BASE move is refused outright rather than held.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-base-proof-"));
  try {
    await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
    await fs.writeFile(path.join(root, ".rbox", "state.json"), JSON.stringify(state()));
    await expect(applyStateSavePacket(root, {
      expectedStream: "s", expectedNonce: "0".repeat(32), sourceGlobalSeq: 2,
      repos: [{ relPath: "r", expectedRepoGen: 3, newRecord: { sourceSeq: 2, base: section(U) } }],
    })).rejects.toThrow(ProoflessBaseError);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("published-intent recovery with no proof holds, never installs on a bare claim", async () => {
  // Recovery no longer treats a missing proof as license to install. A raw
  // savePublishedRepoIntent call — no observed-landing proof, no verified disk —
  // falls to carry, which holds the branch move. Install requires the
  // observed-landing proof the disk-verified recovery supplies (below / journal.test.ts).
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-base-proof-intent-"));
  try {
    await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
    await fs.writeFile(path.join(root, ".rbox", "state.json"), JSON.stringify(state()));
    const recovered = await savePublishedRepoIntent(root, state(), "r", {
      record: { sourceSeq: 2, base: section(U) }, expectedRepoGen: 3, relPath: "r",
    });
    const record = recovered.state.repoRecords?.r;
    expect(record?.base?.refs["refs/heads/main"]).toBe(T);
    expect(record?.pending).toEqual(section(U));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an observed-landing proof installs the refs it saw, and holds any the candidate adds beyond them", async () => {
  const previous = { base: section(T), branchBaseOrigins: { "refs/heads/main": origin } };
  // The verified recovery observed main advancing T -> U. That, and only that,
  // installs; a candidate that also claims a ref the observation never saw is
  // held on that ref — the security boundary for a forged/stale intended record.
  const honest = observedLandingRepoBaseProof({ "refs/heads/main": U });
  const composed = composeRepoBase(previous, { base: section(U) }, honest.authority, honest.lockedProof);
  expect(composed.disposition).toBe("terminal");
  expect(composed.base?.refs["refs/heads/main"]).toBe(U);

  const forgedSection: GitSection = { ...section(U), refs: { "refs/heads/main": U, "refs/heads/evil": U } };
  const forged = composeRepoBase(previous, { base: forgedSection }, honest.authority, honest.lockedProof);
  expect(forged.disposition).toBe("pending");
  expect(forged.holds.some((h) => h.ref === "refs/heads/evil" && h.code === "missing-branch-proof")).toBe(true);
});

test("blanket migration authority is refused by the JSON store no matter what", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-base-proof-blanket-store-"));
  try {
    await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
    await fs.writeFile(path.join(root, ".rbox", "state.json"), JSON.stringify(state()));
    await expect(applyStateSavePacket(root, {
      expectedStream: "s", expectedNonce: "0".repeat(32), sourceGlobalSeq: 2,
      repos: [{ relPath: "r", expectedRepoGen: 3, newRecord: { sourceSeq: 2, base: section(U) },
        baseProof: migrationRepoBaseProof() }],
    })).rejects.toThrow(ProoflessBaseError);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/**
 * Defense in depth only — the contract is the compiler. `MigrationBaseAuthority`
 * carries a non-exported brand (see migration-authority-surface.typecheck.ts),
 * so no import specifier of any shape lets a module construct one. This still
 * pins WHO reaches for the mint: it matches `.js`, `.ts`, and extensionless
 * specifiers in both `import ... from` and `export ... from` position, so a deep
 * import cannot slip past — and a re-export chain cannot either, because its
 * FIRST hop must name this path and would appear in the list below.
 */
test("the mints' importers are a closed list", async () => {
  const src = path.resolve(import.meta.dir, "../..");
  const specifier = /\bfrom\s*\(?\s*["'][^"']*migration\/(base-proof|import-stage)(\.[jt]s)?["']/;
  const importers: string[] = [];
  for (const entry of await fs.readdir(src, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const abs = path.join(entry.parentPath, entry.name);
    if (specifier.test(await fs.readFile(abs, "utf8"))) importers.push(path.relative(src, abs));
  }
  expect(importers.sort(), "migration BASE authority escaped its territory").toEqual([
    // The legacy JSON manifest adoption the blanket authority exists for.
    "cli/sync-state-model.ts",
    // Composer unit test: the one place migration composition semantics are asserted.
    "cli/sync-git/base-composer.test.ts",
    // This file, proving carry composes byte-identically to the old default.
    "cli/sync-git/base-proof-authority.test.ts",
    // U1b store admission test for the tagged-importer reservation.
    "cli/state-plane/store/proofless-base.test.ts",
  ].sort());
});

test("no ordinary state write may name blanket authority, minted or forged", async () => {
  const minted = migrationRepoBaseProof();
  const forged = { authority: { kind: "migration", lineageHash: LIN }, lockedProof: minted.lockedProof } as RepoBaseProof;
  for (const proof of [minted, forged]) {
    expect(() => composeStateSavePacket(state(), source({ bases: { r: section(T) } }, { r: proof })))
      .toThrow(ProoflessBaseError);
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-base-proof-blanket-"));
  try {
    await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
    await fs.writeFile(path.join(root, ".rbox", "state.json"), JSON.stringify(state()));
    await expect(applyStateSavePacket(root, {
      expectedStream: "s", expectedNonce: "0".repeat(32), sourceGlobalSeq: 2,
      repos: [{ relPath: "r", expectedRepoGen: 3, newRecord: { sourceSeq: 2, base: section(T) }, baseProof: forged }],
    })).rejects.toThrow(ProoflessBaseError);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
