import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type GitSection } from "../../engine/index.js";
import { gitIdentityKey, type GitIdentity } from "./identity.js";
import { carryRepoBaseProof, type RepoBaseProof } from "./base-composer.js";
import { projectedKey } from "./shared.js";
import {
  executeRemoteRepositoryDeletion,
  planRemoteRepositoryDeletion,
  sweepRemovedRepoSkeleton,
  RemoteRepositoryDeletionIdentityMismatch,
  type BoundRemoteRepositoryDeletionPlan,
  type RemoteRepositoryDeletionEffects,
  type RemoteRepositoryDeletionIdentity,
  type RemoteRepositoryDeletionInput,
  type RemoteRepositoryDeletionTransition,
} from "./remote-repository-deletion.js";

const ROOT = "/ws";
const REL = "repo";

function identity(overrides: Partial<RemoteRepositoryDeletionIdentity> = {}): RemoteRepositoryDeletionIdentity {
  return { root: ROOT, relPath: REL, repoDir: `${ROOT}/${REL}`, incoming: "absent", ...overrides };
}

function section(head: string): GitSection {
  return { head, refs: { "refs/heads/main": head }, refScope: "all" } as unknown as GitSection;
}

function localIdentity(head: string): GitIdentity {
  return { head, refs: { "refs/heads/main": head }, refScope: "all" } as unknown as GitIdentity;
}

function input(overrides: Partial<RemoteRepositoryDeletionInput> = {}): RemoteRepositoryDeletionInput {
  return {
    identity: identity(),
    pendingSection: undefined,
    baseSection: undefined,
    localIdentity: undefined,
    gitBusy: false,
    leftover: undefined,
    baseApplied: false,
    originLineage: undefined,
    ...overrides,
  };
}

/** Mirrors the mutable sidecar maps `applyGitSections` owns, so the contract can
 * assert byte-exact restoration rather than "revert was called". */
interface SidecarMaps {
  applied: Record<string, GitSection>;
  pending: Record<string, GitSection>;
  needsRes: Record<string, string>;
  removedMem: Record<string, string>;
  deferrals: Record<string, { apply?: { lane: "apply" } } | null>;
  partial: Record<string, { incomingKey: string } | null>;
  attempt: Record<string, { generation: number } | null>;
  idxProj: Record<string, string | null>;
  repoProofs: Record<string, RepoBaseProof>;
}

function emptyMaps(): SidecarMaps {
  return {
    applied: {}, pending: {}, needsRes: {}, removedMem: {},
    deferrals: {}, partial: {}, attempt: {}, idxProj: {}, repoProofs: {},
  };
}

interface Harness {
  effects: RemoteRepositoryDeletionEffects;
  maps: SidecarMaps;
  calls: string[];
  logs: string[];
}

function restoreEntry<T>(target: Record<string, T>, source: Record<string, T>, present: boolean): void {
  if (present) target[REL] = source[REL]!;
  else delete target[REL];
}

function harness(options: {
  maps?: SidecarMaps;
  journalClear?: () => Promise<void>;
  sweep?: () => Promise<void>;
  preserve?: () => Promise<{ recoveryBundle?: string }>;
  beforeCleanup?: () => Promise<void>;
  bind?: RemoteRepositoryDeletionIdentity;
} = {}): Harness {
  const maps = options.maps ?? emptyMaps();
  const calls: string[] = [];
  const logs: string[] = [];
  const effects: RemoteRepositoryDeletionEffects = {
    identity: options.bind ?? identity(),
    commit: (transition) => {
      calls.push("commit");
      const before = JSON.parse(JSON.stringify(maps)) as SidecarMaps;
      const present = Object.fromEntries(
        Object.entries(maps).map(([name, record]) => [
          name,
          Object.prototype.hasOwnProperty.call(record, REL),
        ]),
      ) as Record<string, boolean>;
      delete maps.pending[REL];
      delete maps.needsRes[REL];
      delete maps.applied[REL];
      maps.deferrals[REL] = transition.deferrals;
      maps.partial[REL] = transition.partial;
      maps.attempt[REL] = transition.heldAttempt;
      maps.idxProj[REL] = transition.indexProjection;
      maps.repoProofs[REL] = transition.proof;
      if (transition.removedKey !== null) maps.removedMem[REL] = transition.removedKey;
      return () => {
        calls.push("revert");
        restoreEntry(maps.applied, before.applied, present.applied);
        restoreEntry(maps.pending, before.pending, present.pending);
        restoreEntry(maps.needsRes, before.needsRes, present.needsRes);
        restoreEntry(maps.removedMem, before.removedMem, present.removedMem);
        restoreEntry(maps.deferrals, before.deferrals, present.deferrals);
        restoreEntry(maps.partial, before.partial, present.partial);
        restoreEntry(maps.attempt, before.attempt, present.attempt);
        restoreEntry(maps.idxProj, before.idxProj, present.idxProj);
        restoreEntry(maps.repoProofs, before.repoProofs, present.repoProofs);
      };
    },
    beforeCleanup: async () => {
      calls.push("beforeCleanup");
      await options.beforeCleanup?.();
    },
    clearJournal: async () => {
      calls.push("clearJournal");
      await options.journalClear?.();
    },
    sweepSkeleton: async () => {
      calls.push("sweepSkeleton");
      await options.sweep?.();
    },
    preservePending: async () => {
      calls.push("preservePending");
      return await (options.preserve ?? (async () => ({})))();
    },
    log: (message) => {
      calls.push("log");
      logs.push(message);
    },
  };
  return { effects, maps, calls, logs };
}

describe("planRemoteRepositoryDeletion", () => {
  test("absence supersedes every in-flight input and mints a carry proof", () => {
    const plan = planRemoteRepositoryDeletion(input({
      pendingSection: section("a".repeat(40)),
      baseApplied: true,
      originLineage: "lineage-1",
    }));

    const expected: RemoteRepositoryDeletionTransition = {
      appliedBase: null,
      pending: null,
      resolution: null,
      deferrals: null,
      partial: null,
      heldAttempt: null,
      indexProjection: null,
      removedKey: null,
      proof: carryRepoBaseProof("lineage-1"),
    };
    expect(plan.transition).toEqual(expected);
    expect(plan.journalClear).toBe("required");
    expect(plan.skeletonSweep).toBe("best-effort");
    expect(plan.identity).toEqual(identity());
  });

  test("a missing origin lineage carries the legacy-untrusted marker", () => {
    const plan = planRemoteRepositoryDeletion(input());
    expect(plan.transition.proof).toEqual(carryRepoBaseProof("legacy-untrusted"));
  });

  test("the removal announcement is emitted only when a BASE section was applied", () => {
    expect(planRemoteRepositoryDeletion(input({ baseApplied: true })).removalAnnouncement)
      .toBe("git-sync removed repo (remote deleted; local .git untouched). Your local Git repository is safe.");
    expect(planRemoteRepositoryDeletion(input({ baseApplied: false })).removalAnnouncement).toBeUndefined();
  });

  test("a quiescent leftover records the live identity as the resurrection guard", () => {
    const local = localIdentity("b".repeat(40));
    expect(planRemoteRepositoryDeletion(input({ leftover: "all", localIdentity: local })).transition.removedKey)
      .toBe(gitIdentityKey(local));
    // An unreadable leftover still stamps a guard — the "none" key.
    expect(planRemoteRepositoryDeletion(input({ leftover: "scoped" })).transition.removedKey)
      .toBe(gitIdentityKey(undefined));
  });

  test("a busy leftover records the base section projected onto the leftover shape", () => {
    const base = section("c".repeat(40));
    const local = localIdentity("d".repeat(40));
    expect(planRemoteRepositoryDeletion(input({
      leftover: "all", gitBusy: true, baseSection: base, localIdentity: local,
    })).transition.removedKey).toBe(projectedKey(base, "all"));
    expect(planRemoteRepositoryDeletion(input({
      leftover: "scoped", gitBusy: true, baseSection: base, localIdentity: local,
    })).transition.removedKey).toBe(projectedKey(base, "scoped"));

    // No base to project → the live identity is the only available guard.
    expect(planRemoteRepositoryDeletion(input({
      leftover: "all", gitBusy: true, localIdentity: local,
    })).transition.removedKey).toBe(gitIdentityKey(local));
  });

  test("no leftover means no removal memory is stamped at all", () => {
    expect(planRemoteRepositoryDeletion(input({
      leftover: undefined, localIdentity: localIdentity("e".repeat(40)),
    })).transition.removedKey).toBeNull();
  });

  test("advisory preservation is authorized only for a diverged pending apply", () => {
    const base = section("f".repeat(40));
    const pend = section("0".repeat(40));

    // Diverged: the local identity differs from BASE while an apply was pending.
    expect(planRemoteRepositoryDeletion(input({
      pendingSection: pend, baseSection: base, localIdentity: localIdentity("1".repeat(40)),
    })).conflictPreservation).toEqual({ section: pend });

    // Converged local work has nothing to conflict with.
    expect(planRemoteRepositoryDeletion(input({
      pendingSection: pend, baseSection: base, localIdentity: localIdentity("f".repeat(40)),
    })).conflictPreservation).toBeUndefined();

    // No pending apply at all: absence is plain removal, never a conflict.
    expect(planRemoteRepositoryDeletion(input({
      baseSection: base, localIdentity: localIdentity("1".repeat(40)),
    })).conflictPreservation).toBeUndefined();

    // No readable local repository: there is no local work to preserve.
    expect(planRemoteRepositoryDeletion(input({
      pendingSection: pend, baseSection: base, localIdentity: undefined,
    })).conflictPreservation).toBeUndefined();
  });
});

describe("executeRemoteRepositoryDeletion", () => {
  test("performs exactly the ordered effect sequence the plan authorizes", async () => {
    const plan = planRemoteRepositoryDeletion(input({
      baseApplied: true,
      pendingSection: section("f".repeat(40)),
      baseSection: section("a".repeat(40)),
      localIdentity: localIdentity("b".repeat(40)),
    }));
    const h = harness();

    const receipt = await executeRemoteRepositoryDeletion(plan, h.effects);

    expect(h.calls).toEqual([
      "commit", "log", "beforeCleanup", "clearJournal", "sweepSkeleton", "preservePending", "log",
    ]);
    expect(receipt.identity).toEqual(plan.identity);
    expect(receipt.transition).toEqual(plan.transition);
    expect(receipt.journalCleared).toBe(true);
    expect(receipt.skeletonSweep).toBe("attempted");
    expect(receipt.conflictPreservation).toBe("preserved");
    expect(receipt.eligibleForCommit).toBe(true);
  });

  test("the executor's whole vocabulary is sidecar effects — no .git mutation is reachable", async () => {
    const plan = planRemoteRepositoryDeletion(input({ baseApplied: true }));
    const h = harness();
    const touched = new Set<string>();
    const watched = new Proxy(h.effects, {
      get(target, property, receiver) {
        if (typeof property === "string") touched.add(property);
        return Reflect.get(target, property, receiver);
      },
    });

    await executeRemoteRepositoryDeletion(plan, watched);

    expect([...touched].sort()).toEqual([
      "beforeCleanup", "clearJournal", "commit", "identity", "log", "sweepSkeleton",
    ]);
  });

  test("the anchored sweep leaves a retained .git byte-exact", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-deletion-"));
    try {
      const repo = path.join(root, REL);
      await fs.mkdir(path.join(repo, ".git", "objects"), { recursive: true });
      await fs.writeFile(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
      await fs.mkdir(path.join(repo, "empty", "deeper"), { recursive: true });

      await sweepRemovedRepoSkeleton(root, REL);

      expect(await fs.readFile(path.join(repo, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
      expect((await fs.lstat(path.join(repo, ".git", "objects"))).isDirectory()).toBe(true);
      await expect(fs.lstat(path.join(repo, "empty"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("a required journal-clear failure sweeps, reverts byte-exact, and rethrows", async () => {
    const maps = emptyMaps();
    const base = section("a".repeat(40));
    const pend = section("b".repeat(40));
    maps.applied[REL] = base;
    maps.pending[REL] = pend;
    maps.needsRes[REL] = "resolution-key";
    maps.removedMem[REL] = "prior-memory";
    maps.deferrals[REL] = { apply: { lane: "apply" } };
    maps.partial[REL] = { incomingKey: "k" };
    maps.attempt[REL] = { generation: 3 };
    maps.idxProj[REL] = "projection";
    maps.repoProofs[REL] = carryRepoBaseProof("prior-lineage");
    const before = JSON.parse(JSON.stringify(maps)) as SidecarMaps;

    const failure = new Error("journal clear failed");
    const h = harness({
      maps,
      journalClear: async () => { throw failure; },
      preserve: async () => ({ recoveryBundle: "refs/rbox-conflict/x" }),
    });
    const plan = planRemoteRepositoryDeletion(input({
      baseApplied: true, pendingSection: pend, baseSection: base,
      localIdentity: localIdentity("c".repeat(40)), leftover: "all",
    }));

    await expect(executeRemoteRepositoryDeletion(plan, h.effects)).rejects.toBe(failure);

    // The best-effort sweep still runs; preservation never does; state is byte-exact.
    expect(h.calls).toEqual(["commit", "log", "beforeCleanup", "clearJournal", "sweepSkeleton", "revert"]);
    expect(maps).toEqual(before);
  });

  test("a journal-clear failure on a repo with no prior sidecar rows leaves the keys absent", async () => {
    const maps = emptyMaps();
    const failure = new Error("nope");
    const h = harness({ maps, journalClear: async () => { throw failure; } });

    await expect(
      executeRemoteRepositoryDeletion(planRemoteRepositoryDeletion(input({ leftover: "all" })), h.effects),
    ).rejects.toBe(failure);

    for (const record of Object.values(maps)) {
      expect(Object.prototype.hasOwnProperty.call(record, REL)).toBe(false);
    }
  });

  test("an advisory preservation failure never falsifies the required disposition", async () => {
    const maps = emptyMaps();
    maps.applied[REL] = section("a".repeat(40));
    const pend = section("b".repeat(40));
    const h = harness({ maps, preserve: async () => { throw new Error("blob store down"); } });
    const plan = planRemoteRepositoryDeletion(input({
      baseApplied: true, pendingSection: pend, baseSection: section("a".repeat(40)),
      localIdentity: localIdentity("c".repeat(40)),
    }));

    const receipt = await executeRemoteRepositoryDeletion(plan, h.effects);

    expect(receipt.journalCleared).toBe(true);
    expect(receipt.eligibleForCommit).toBe(true);
    expect(receipt.conflictPreservation).toBe("failed");
    expect(h.calls).not.toContain("revert");
    expect(maps.applied[REL]).toBeUndefined();
    expect(h.logs.at(-1)).toBe(
      "git-sync WARNING repo: could not preserve the pending remote section after the remote deletion (local work untouched): blob store down",
    );
  });

  test("the preserved-conflict log names the recovery bundle, or the namespace when unknown", async () => {
    const plan = planRemoteRepositoryDeletion(input({
      pendingSection: section("b".repeat(40)), baseSection: section("a".repeat(40)),
      localIdentity: localIdentity("c".repeat(40)),
    }));

    const named = harness({ preserve: async () => ({ recoveryBundle: "refs/rbox-conflict/2026" }) });
    await executeRemoteRepositoryDeletion(plan, named.effects);
    expect(named.logs.at(-1)).toBe(
      "git-sync CONFLICT repo — remote deleted the repo while an apply was pending and local diverged; local kept, pending remote preserved at refs/rbox-conflict/2026. Your local Git work is safe; inspect the preserved incoming state before resolving.",
    );

    const unnamed = harness({ preserve: async () => ({}) });
    await executeRemoteRepositoryDeletion(plan, unnamed.effects);
    expect(unnamed.logs.at(-1)).toContain("preserved at refs/rbox-conflict/*.");
  });

  test("pending and partial absence cannot resurrect through this transition", async () => {
    const maps = emptyMaps();
    maps.pending[REL] = section("b".repeat(40));
    maps.partial[REL] = { incomingKey: "k" };
    maps.attempt[REL] = { generation: 1 };
    maps.needsRes[REL] = "resolution";
    maps.applied[REL] = section("a".repeat(40));
    const h = harness({ maps });

    await executeRemoteRepositoryDeletion(
      planRemoteRepositoryDeletion(input({ baseApplied: true, leftover: "all", localIdentity: localIdentity("c".repeat(40)) })),
      h.effects,
    );

    expect(maps.pending[REL]).toBeUndefined();
    expect(maps.applied[REL]).toBeUndefined();
    expect(maps.needsRes[REL]).toBeUndefined();
    expect(maps.partial[REL]).toBeNull();
    expect(maps.attempt[REL]).toBeNull();
    expect(maps.deferrals[REL]).toBeNull();
    expect(maps.idxProj[REL]).toBeNull();
    expect(maps.removedMem[REL]).toBeDefined();
  });

  test("a plan bound to another repository is refused before any effect runs", async () => {
    const plan: BoundRemoteRepositoryDeletionPlan =
      planRemoteRepositoryDeletion(input({ identity: identity({ relPath: "other", repoDir: `${ROOT}/other` }) }));
    const h = harness();

    await expect(executeRemoteRepositoryDeletion(plan, h.effects))
      .rejects.toBeInstanceOf(RemoteRepositoryDeletionIdentityMismatch);
    expect(h.calls).toEqual([]);
  });

  test("a plan bound to another workspace root is refused", async () => {
    const plan = planRemoteRepositoryDeletion(input({ identity: identity({ root: "/other-ws" }) }));
    const h = harness();

    await expect(executeRemoteRepositoryDeletion(plan, h.effects))
      .rejects.toBeInstanceOf(RemoteRepositoryDeletionIdentityMismatch);
    expect(h.calls).toEqual([]);
  });
});
