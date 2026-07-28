import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { canonicalize } from "../engine/e2ee/jcs.js";
import { pruneTrash } from "../engine/trash.js";
import { boundedHash } from "./reset-io.js";
import {
  inspectResetQuarantineResidue,
  quarantineResetUnderFence,
  resetQuarantineRoot,
  restoreResetQuarantineUnderFence,
  resumeResetQuarantinesUnderFence,
  type ResetQuarantinePlan,
} from "./reset-quarantine.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(scope: "journal-only" | "transaction" = "transaction") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-reset-quarantine-"));
  roots.push(root);
  const stateDir = path.join(root, ".rbox", "state");
  await fs.mkdir(path.join(stateDir, "reset-candidates"), { recursive: true });
  await fs.mkdir(path.join(stateDir, "lineages", "nonce"), { recursive: true });
  const active = path.join(root, ".rbox", "state.json");
  const journal = path.join(stateDir, "reset-v1.json");
  const candidate = path.join(stateDir, "reset-candidates", "candidate.json");
  const archive = path.join(stateDir, "lineages", "nonce", "archive.json");
  await fs.writeFile(active, "old-state\n");
  const nextState = {
    stream: "next-stream", stateNonce: "b".repeat(32), stateRevision: 0,
    lastSyncedSequence: 0, lastSyncedManifest: { generatedAt: "", files: [] }, repoRecords: {},
  };
  const candidateBytes = Buffer.concat([Buffer.from(canonicalize(nextState)), Buffer.from("\n")]);
  const digest = (bytes: Uint8Array) => crypto.createHash("sha256").update(bytes).digest("hex");
  const journalBytes = Buffer.concat([Buffer.from(canonicalize({
    v: 2,
    id: "1".repeat(32),
    phase: "prepared",
    createdAt: "2026-07-17T12:00:00.000Z",
    authorization: { version: 2, authorizedNextStream: "next-stream", consentKind: "setup-rebind", mintedAtRevision: 0 },
    old: { stream: "old-stream", stateNonce: "a".repeat(32), stateRevision: 0, stateSha256: digest(Buffer.from("old-state\n")), archiveBaseline: "absent", z: [] },
    next: { stream: "next-stream", stateNonce: "b".repeat(32), stateRevision: 0, stateSha256: digest(candidateBytes), state: nextState },
  })), Buffer.from("\n")]);
  await fs.writeFile(journal, journalBytes);
  await fs.writeFile(candidate, candidateBytes);
  await fs.writeFile(archive, "archive\n");
  const plan: ResetQuarantinePlan = {
    scope,
    phase: scope === "journal-only" ? "malformed" : "prepared",
    activeStateSha256: await boundedHash(active),
    recoveredStateSha256: await boundedHash(candidate),
    markerPrecondition: "absent",
    refPreconditions: JSON.stringify({
      recovery: { kind: "prefix", count: 0, total: 0 },
      active: { kind: "prefix", count: 0, total: 0 },
    }),
    artifacts: scope === "journal-only"
      ? [{ kind: "journal", absolutePath: journal, cleanup: "remove-exact" }]
      : [
          { kind: "journal", absolutePath: journal, cleanup: "remove-exact" },
          { kind: "candidate", absolutePath: candidate, cleanup: "remove-exact" },
          { kind: "archive", absolutePath: archive, cleanup: "preserve" },
        ],
  };
  return { root, active, journal, candidate, archive, plan, journalBytes, candidateBytes };
}

const fixedHooks = {
  now: () => new Date("2026-07-17T12:00:00.000Z"),
  randomBytes: () => Buffer.from("0011223344556677", "hex"),
};

describe("reset quarantine transaction", () => {
  for (const point of [
    "after-manifest-publish",
    "after-journal-copy",
    "after-candidate-copy",
    "after-archive-copy",
    "after-manifest-fsync",
    "before-commit-publish",
    "after-commit-temp-fsync",
    "after-commit-rename",
    "after-commit-publish",
    "after-journal-remove",
    "after-candidate-remove",
  ]) {
    test(`crash-resumes at ${point}`, async () => {
      const f = await fixture();
      const injected = new Error(point);
      await expect(quarantineResetUnderFence(f.root, f.plan, {
        ...fixedHooks,
        crashAt: (seen) => { if (seen === point) throw injected; },
      })).rejects.toBe(injected);

      const committed = ["after-commit-rename", "after-commit-publish", "after-journal-remove", "after-candidate-remove"].includes(point);
      if (!committed) {
        expect(await fs.readFile(f.journal)).toEqual(f.journalBytes);
        expect(await fs.readFile(f.candidate)).toEqual(f.candidateBytes);
      }
      await resumeResetQuarantinesUnderFence(f.root);
      if (committed) {
        expect(await fs.lstat(f.journal).catch(() => undefined)).toBeUndefined();
        expect(await fs.lstat(f.candidate).catch(() => undefined)).toBeUndefined();
        expect(await fs.readFile(f.archive, "utf8")).toBe("archive\n");
      } else {
        expect(await fs.readdir(resetQuarantineRoot(f.root))).toEqual([]);
      }
    });
  }

  test("an ordinary COMMITTED publication failure removes only its exact temp", async () => {
    const f = await fixture();
    await expect(quarantineResetUnderFence(f.root, f.plan, {
      ...fixedHooks,
      crashAt: (point) => {
        if (point === "after-commit-temp-fsync") throw new Error("publication failed");
      },
    })).rejects.toThrow("publication failed");
    const [id] = await fs.readdir(resetQuarantineRoot(f.root));
    const names = await fs.readdir(path.join(resetQuarantineRoot(f.root), id!));
    expect(names.some((name) => name.endsWith("-COMMITTED"))).toBe(false);
    expect(names).toContain("manifest.json");
    expect(names).toContain("artifacts");
  });

  test("COMMITTED residue is classified without resuming candidate cleanup across Q", async () => {
    const f = await fixture();
    await expect(quarantineResetUnderFence(f.root, f.plan, {
      ...fixedHooks,
      crashAt: (point) => {
        if (point === "after-journal-remove") throw new Error("leave residue");
      },
    })).rejects.toThrow("leave residue");
    expect(await fs.lstat(f.journal).catch(() => undefined)).toBeUndefined();
    const candidateBefore = await fs.readFile(f.candidate);
    const archiveBefore = await fs.readFile(f.archive);

    const preQ = await inspectResetQuarantineResidue(f.root, "legacy-json");
    expect(preQ.kind).toBe("quarantine-pending");
    expect(await fs.readFile(f.candidate)).toEqual(candidateBefore);
    expect(await fs.readFile(f.archive)).toEqual(archiveBefore);

    const postQ = await inspectResetQuarantineResidue(f.root, "sqlite");
    expect(postQ.kind).toBe("post-q-quarantine-residue");
    expect(await fs.readFile(f.candidate)).toEqual(candidateBefore);
    expect(await fs.readFile(f.archive)).toEqual(archiveBefore);
  });

  test("copies the durable archive and never removes its canonical provenance", async () => {
    const f = await fixture();
    const bundle = await quarantineResetUnderFence(f.root, f.plan, fixedHooks);
    expect(await fs.readFile(f.archive, "utf8")).toBe("archive\n");
    expect(await fs.readFile(path.join(bundle, "artifacts", "2-archive"), "utf8")).toBe("archive\n");
  });

  test("an invalid commit record is treated as no commit and partial bundle cleanup", async () => {
    const f = await fixture();
    await expect(quarantineResetUnderFence(f.root, f.plan, {
      ...fixedHooks,
      crashAt: (point) => { if (point === "before-commit-publish") throw new Error("crash"); },
    })).rejects.toThrow("crash");
    const [id] = await fs.readdir(resetQuarantineRoot(f.root));
    const bundle = path.join(resetQuarantineRoot(f.root), id!);
    await fs.writeFile(path.join(bundle, "COMMITTED"), "partial");
    await resumeResetQuarantinesUnderFence(f.root);
    expect(await fs.readdir(resetQuarantineRoot(f.root))).toEqual([]);
    expect(await fs.readFile(f.journal)).toEqual(f.journalBytes);
    expect(await fs.readFile(f.candidate)).toEqual(f.candidateBytes);
  });

  test("journal-only mode leaves unidentifiable artifacts untouched", async () => {
    const f = await fixture("journal-only");
    await quarantineResetUnderFence(f.root, f.plan, fixedHooks);
    expect(await fs.lstat(f.journal).catch(() => undefined)).toBeUndefined();
    expect(await fs.readFile(f.candidate)).toEqual(f.candidateBytes);
    expect(await fs.readFile(f.archive, "utf8")).toBe("archive\n");
  });

  test("leaves a replacement candidate written by a later reset", async () => {
    const f = await fixture();
    await expect(quarantineResetUnderFence(f.root, f.plan, {
      ...fixedHooks,
      crashAt: async (point) => {
        if (point === "after-journal-remove") {
          await fs.writeFile(f.candidate, "new reset candidate\n");
          throw new Error("crash");
        }
      },
    })).rejects.toThrow("crash");
    await resumeResetQuarantinesUnderFence(f.root);
    expect(await fs.readFile(f.candidate, "utf8")).toBe("new reset candidate\n");
  });

  test("a replacement journal fences all remaining old cleanup", async () => {
    const f = await fixture();
    await expect(quarantineResetUnderFence(f.root, f.plan, {
      ...fixedHooks,
      crashAt: async (point) => {
        if (point === "after-commit-publish") {
          await fs.writeFile(f.journal, "new reset journal\n");
          await fs.writeFile(f.candidate, "candidate\n");
          throw new Error("crash");
        }
      },
    })).rejects.toThrow("crash");
    await resumeResetQuarantinesUnderFence(f.root);
    expect(await fs.readFile(f.journal, "utf8")).toBe("new reset journal\n");
    expect(await fs.readFile(f.candidate, "utf8")).toBe("candidate\n");
  });

  test("survives age, cap, and trash-empty pruning", async () => {
    const f = await fixture();
    const bundle = await quarantineResetUnderFence(f.root, f.plan, fixedHooks);
    const old = Date.parse("2027-08-01T00:00:00.000Z");
    await pruneTrash(f.root, { days: 1, maxBytes: Infinity, now: old });
    expect(await fs.stat(bundle)).toBeDefined();
    await pruneTrash(f.root, { days: 365, maxBytes: 0, now: old });
    expect(await fs.stat(bundle)).toBeDefined();
    await pruneTrash(f.root, { days: 0, maxBytes: Infinity, now: old });
    expect(await fs.stat(bundle)).toBeDefined();
  });
});

describe("reset quarantine restore", () => {
  test("restores inert artifacts first and publishes the journal last across crashes", async () => {
    for (const point of ["after-candidate-restore", "before-journal-publish", "after-journal-publish"]) {
      const f = await fixture();
      const bundle = await quarantineResetUnderFence(f.root, f.plan, fixedHooks);
      // Archive deliberately remains exact at its canonical path and is accepted.
      await expect(restoreResetQuarantineUnderFence(f.root, bundle, { configEligible: true }, {
        crashAt: (seen) => { if (seen === point) throw new Error(point); },
      })).rejects.toThrow(point);
      if (point !== "after-journal-publish") expect(await fs.lstat(f.journal).catch(() => undefined)).toBeUndefined();
      const result = await restoreResetQuarantineUnderFence(f.root, bundle, { configEligible: true });
      expect(["restored", "already-restored"]).toContain(result);
      expect(await fs.readFile(f.journal)).toEqual(f.journalBytes);
      expect(await fs.readFile(f.candidate)).toEqual(f.candidateBytes);
    }
  });

  test("refuses restore after active state advance or config disagreement", async () => {
    const f = await fixture();
    const bundle = await quarantineResetUnderFence(f.root, f.plan, fixedHooks);
    await fs.writeFile(f.active, "advanced\n");
    await expect(restoreResetQuarantineUnderFence(f.root, bundle, { configEligible: true })).rejects.toThrow("active state advanced");
    await fs.writeFile(f.active, "old-state\n");
    await expect(restoreResetQuarantineUnderFence(f.root, bundle, { configEligible: false })).rejects.toThrow("durable config is not eligible");
  });

  test("refuses restore when the captured incarnation-marker plane changed", async () => {
    const f = await fixture();
    const bundle = await quarantineResetUnderFence(f.root, f.plan, fixedHooks);
    await fs.writeFile(path.join(f.root, ".rbox", "state", "state-incarnation.json"), JSON.stringify({
      stream: "next-stream", stateNonce: "b".repeat(32), stateRevision: 0,
    }));
    await expect(restoreResetQuarantineUnderFence(f.root, bundle, { configEligible: true }))
      .rejects.toThrow("marker or recovery refs changed");
    expect(await fs.lstat(f.candidate).catch(() => undefined)).toBeUndefined();
  });

  for (const secondFailure of ["different journal", "changed candidate"] as const) {
    test(`marker/ref refusal retains precedence over ${secondFailure}`, async () => {
      const f = await fixture();
      const bundle = await quarantineResetUnderFence(f.root, f.plan, fixedHooks);
      await fs.writeFile(path.join(f.root, ".rbox", "state", "state-incarnation.json"), JSON.stringify({
        stream: "next-stream", stateNonce: "b".repeat(32), stateRevision: 0,
      }));
      if (secondFailure === "different journal") await fs.writeFile(f.journal, "replacement journal\n");
      else await fs.writeFile(f.candidate, "replacement candidate\n");
      await expect(restoreResetQuarantineUnderFence(f.root, bundle, { configEligible: true }))
        .rejects.toThrow("marker or recovery refs changed");
    });
  }

  test("already-recovered exact next state is idempotent success", async () => {
    const f = await fixture();
    const bundle = await quarantineResetUnderFence(f.root, f.plan, fixedHooks);
    await fs.writeFile(f.active, f.candidateBytes);
    expect(await restoreResetQuarantineUnderFence(f.root, bundle, { configEligible: true })).toBe("already-restored");
    expect(await fs.lstat(bundle).catch(() => undefined)).toBeUndefined();
    expect(await fs.lstat(f.journal).catch(() => undefined)).toBeUndefined();
  });
});
