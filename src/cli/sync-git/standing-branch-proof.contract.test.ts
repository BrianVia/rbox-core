import { describe, expect, test } from "bun:test";
import type {
  ArtifactBinding,
  ArtifactReadResult,
  BasePresentPayload,
  GitSection,
  PRepairAttemptResult,
  PRepairReceipt,
  PRepairResumeResult,
  PreparedProtocolRef,
} from "../../engine/index.js";
import type { RepoRecord, SyncState } from "../config.js";
import type { FollowerBranchProtocol, FollowerBranchProtocolResult } from "./follower-protocol.js";
import type { ExactPSettlementResult } from "./p-settlement.js";
import {
  settleStandingBranchProof,
  type StandingBranchProofInput,
  type StandingProofPort,
  type StandingRepairAttempt,
} from "./standing-branch-proof.js";

const REL = "repo";
const INCOMING_KEY = "incoming-key-1";
const BINDING = { lineageHash: "l".repeat(64), repositoryIdentityHash: "r".repeat(64) } as unknown as ArtifactBinding;

function section(refScope: GitSection["refScope"], head = "a".repeat(40)): GitSection {
  return { head, refs: {}, refScope } as unknown as GitSection;
}

function preparedRef(ref: string): PreparedProtocolRef<BasePresentPayload> {
  return {
    ref: `refs/rbox-base/present/${ref}`,
    targetOid: "0".repeat(40),
    payload: { ref, episode: "e".repeat(32), priorOid: null, nextOid: "1".repeat(40) },
    payloadBytes: new Uint8Array(),
  } as unknown as PreparedProtocolRef<BasePresentPayload>;
}

function protocol(overrides: Partial<FollowerBranchProtocol> = {}): FollowerBranchProtocol {
  return {
    binding: BINDING,
    lineageHash: BINDING.lineageHash,
    repositoryIdentityHash: BINDING.repositoryIdentityHash,
    logicalBaseRefs: {},
    attestations: {} as FollowerBranchProtocol["attestations"],
    artifacts: {},
    presentArtifacts: [],
    unmaterializedAbsenceRefs: new Set<string>(),
    absenceWitnesses: {},
    ...overrides,
  };
}

function exactDisposition(): FollowerBranchProtocol["artifacts"][string] {
  return { absence: "absent", present: "valid-owning", keeps: "exact", settledAbsence: "absent" };
}

function state(revision: number, stream = "stream-1"): SyncState {
  return { stream, stateRevision: revision, lastSyncedSequence: 1, lastSyncedManifest: { generatedAt: "now", files: [] } } as unknown as SyncState;
}

function record(base: GitSection | undefined, pRepaired?: Record<string, PRepairReceipt>): RepoRecord {
  return {
    repoGen: 1,
    sourceSeq: 1,
    ...(base ? { base } : {}),
    ...(pRepaired ? { partial: { incomingKey: INCOMING_KEY, appliedRefs: {}, heldRefs: {}, configApplied: true, pRepaired } } : {}),
  } as unknown as RepoRecord;
}

function receipt(ref: string): PRepairReceipt {
  return { ref, episode: "e".repeat(32) } as unknown as PRepairReceipt;
}

interface Trace {
  readonly calls: string[];
  readonly repairs: StandingRepairAttempt[];
  readonly refreshes: Array<{ state: SyncState; record: RepoRecord | undefined; base: GitSection | undefined }>;
  readonly compacts: Array<{ stream: string; effectiveRefScope: GitSection["refScope"] }>;
  readonly settles: Array<{ state: SyncState; binding: ArtifactBinding; ref: string }>;
}

function port(overrides: Partial<StandingProofPort> = {}): StandingProofPort & { trace: Trace } {
  const trace: Trace = { calls: [], repairs: [], refreshes: [], compacts: [], settles: [] };
  const merged: StandingProofPort = {
    now: () => "1970-01-01T00:00:00.000Z",
    inspectTerminalReceipt: async () => ({ action: "recompute" }),
    compactTerminalReceipt: async () => "accepted",
    settleExactArtifact: async () => ({ status: "absent" }),
    resumeAcceptedRepair: async () => ({ status: "hold", reason: "unexpected resume" }),
    refreshAcceptedRepair: async () => ({ status: "hold", reason: "unexpected refresh" }),
    runRepairAttempt: async () => ({ status: "hold", reason: "unexpected attempt" }),
    readStandingArtifact: async () => ({ status: "absent" } as unknown as ArtifactReadResult<BasePresentPayload>),
    reloadState: async () => state(2),
    refreshProtocol: async () => ({ status: "ready", protocol: protocol() } satisfies FollowerBranchProtocolResult),
    ...overrides,
  };
  return {
    trace,
    now: merged.now,
    inspectTerminalReceipt: (receipt) => {
      trace.calls.push("inspect");
      return merged.inspectTerminalReceipt(receipt);
    },
    compactTerminalReceipt: (params) => {
      trace.calls.push("compact");
      trace.compacts.push({ stream: params.stream, effectiveRefScope: params.effectiveRefScope });
      return merged.compactTerminalReceipt(params);
    },
    settleExactArtifact: (params) => {
      trace.calls.push("settle");
      trace.settles.push({ state: params.state, binding: params.binding, ref: params.p.payload.ref });
      return merged.settleExactArtifact(params);
    },
    resumeAcceptedRepair: (params) => {
      trace.calls.push("resume");
      return merged.resumeAcceptedRepair(params);
    },
    refreshAcceptedRepair: (params) => {
      trace.calls.push("refresh-accepted");
      trace.repairs.push(params);
      return merged.refreshAcceptedRepair(params);
    },
    runRepairAttempt: (params) => {
      trace.calls.push("run-repair");
      trace.repairs.push(params);
      return merged.runRepairAttempt(params);
    },
    readStandingArtifact: (binding, ref) => {
      trace.calls.push("read-artifact");
      return merged.readStandingArtifact(binding, ref);
    },
    reloadState: () => {
      trace.calls.push("reload");
      return merged.reloadState();
    },
    refreshProtocol: (source) => {
      trace.calls.push("refresh-protocol");
      trace.refreshes.push(source);
      return merged.refreshProtocol(source);
    },
  };
}

function input(overrides: Partial<StandingBranchProofInput> = {}): StandingBranchProofInput {
  return {
    identity: { relPath: REL, incomingKey: INCOMING_KEY },
    state: state(1),
    record: undefined,
    serializedBase: undefined,
    incomingRefScope: "all",
    protocol: protocol(),
    retryBudget: 8,
    ...overrides,
  };
}

describe("SettleStandingBranchProof", () => {
  test("no terminal receipt and no standing P settles with the caller's protocol and zero effects", async () => {
    const effects = port();
    const bound = input();
    const result = await settleStandingBranchProof(bound, effects);

    expect(result.kind).toBe("settled");
    if (result.kind !== "settled") throw new Error("unreachable");
    expect(result.protocol).toBe(bound.protocol);
    expect(result.carry).toEqual({ state: bound.state, base: undefined, recoveredRecord: undefined });
    expect(result.disposition).toEqual({ relPath: REL, incomingKey: INCOMING_KEY, passes: 0, outcomes: [] });
    expect(effects.trace.calls).toEqual([]);
  });

  test("a compact-and-restart terminal row compacts, reloads, and carries the reloaded record and its BASE", async () => {
    const reloaded = record(section("branches"));
    const effects = port({
      inspectTerminalReceipt: async () => ({ action: "compact-and-restart" }),
      reloadState: async () => ({ ...state(2), repoRecords: { [REL]: reloaded } }) as unknown as SyncState,
    });
    const result = await settleStandingBranchProof(
      input({ record: record(section("all"), { "refs/heads/main": receipt("refs/heads/main") }), serializedBase: section("all") }),
      effects,
    );

    expect(result.kind).toBe("settled");
    expect(result.carry.recoveredRecord).toEqual(reloaded);
    expect(result.carry.base).toEqual(reloaded.base);
    expect(result.carry.state.stateRevision).toBe(2);
    if (result.kind !== "settled") throw new Error("unreachable");
    expect(result.disposition.outcomes).toEqual(["compacted"]);
  });

  test("terminal rows derive the effective ref scope from the BASE standing at that row, not the entry BASE", async () => {
    const reloaded = record(section("branches"));
    let inspected = 0;
    const effects = port({
      inspectTerminalReceipt: async () => {
        inspected += 1;
        return { action: "compact-and-restart" as never };
      },
      reloadState: async () => ({ ...state(1 + inspected), repoRecords: { [REL]: reloaded } }) as unknown as SyncState,
    });
    await settleStandingBranchProof(
      input({
        serializedBase: section("all"),
        record: record(section("all"), {
          "refs/heads/one": receipt("refs/heads/one"),
          "refs/heads/two": receipt("refs/heads/two"),
        }),
      }),
      effects,
    );

    expect(effects.trace.compacts.map((entry) => entry.effectiveRefScope)).toEqual(["all", "branches"]);
  });

  test("a terminal row with no serialized BASE falls back to the incoming ref scope", async () => {
    const effects = port({ inspectTerminalReceipt: async () => ({ action: "compact-and-restart" }) });
    await settleStandingBranchProof(
      input({
        incomingRefScope: "branches",
        record: record(undefined, { "refs/heads/main": receipt("refs/heads/main") }),
      }),
      effects,
    );

    expect(effects.trace.compacts[0]?.effectiveRefScope).toBe("branches");
  });

  test("a rejected terminal CAS holds by ref with the exact classification", async () => {
    const effects = port({
      inspectTerminalReceipt: async () => ({ action: "compact-and-restart" }),
      compactTerminalReceipt: async () => "rejected",
    });
    const result = await settleStandingBranchProof(
      input({ record: record(undefined, { "refs/heads/main": receipt("refs/heads/main") }) }),
      effects,
    );

    expect(result).toMatchObject({
      kind: "held",
      hold: { reason: "P-repair terminal receipt CAS rejected for refs/heads/main", deferralReason: "artifact" },
    });
  });

  test("a failed terminal reload holds without carrying a record", async () => {
    const effects = port({
      inspectTerminalReceipt: async () => ({ action: "compact-and-restart" }),
      reloadState: async () => undefined,
    });
    const result = await settleStandingBranchProof(
      input({ record: record(undefined, { "refs/heads/main": receipt("refs/heads/main") }) }),
      effects,
    );

    expect(result).toMatchObject({ kind: "held", hold: { reason: "P-repair terminal state reload failed", deferralReason: "artifact" } });
    expect(result.carry.recoveredRecord).toBeUndefined();
  });

  for (const action of ["corruption-hold", "artifact-contradiction-hold"] as const) {
    test(`a ${action} terminal inspection holds with the named ref and action`, async () => {
      const effects = port({ inspectTerminalReceipt: async () => ({ action }) });
      const result = await settleStandingBranchProof(
        input({ record: record(undefined, { "refs/heads/main": receipt("refs/heads/main") }) }),
        effects,
      );

      expect(result).toMatchObject({
        kind: "held",
        hold: { reason: `P-repair terminal inspection refused refs/heads/main: ${action}`, deferralReason: "artifact" },
      });
    });
  }

  test("an exact settlement adopts the settled state, refreshes the protocol, and reports one pass", async () => {
    const settled = state(9);
    const next = protocol();
    const effects = port({
      settleExactArtifact: async () => ({ status: "settled", state: settled, ref: "refs/heads/main" }) satisfies ExactPSettlementResult,
      refreshProtocol: async () => ({ status: "ready", protocol: next }),
    });
    const result = await settleStandingBranchProof(
      input({ protocol: protocol({ presentArtifacts: [preparedRef("refs/heads/main")] }) }),
      effects,
    );

    expect(result.kind).toBe("settled");
    if (result.kind !== "settled") throw new Error("unreachable");
    expect(result.protocol).toBe(next);
    expect(result.carry.state).toBe(settled);
    expect(result.disposition).toMatchObject({ passes: 1, outcomes: ["settled"] });
    expect(effects.trace.calls).toEqual(["settle", "refresh-protocol"]);
  });

  test("an exact-settlement hold classifies as an artifact deferral with the settlement reason", async () => {
    const effects = port({ settleExactArtifact: async () => ({ status: "hold", reason: "prepared ref rejected" }) });
    const result = await settleStandingBranchProof(
      input({ protocol: protocol({ presentArtifacts: [preparedRef("refs/heads/main")] }) }),
      effects,
    );

    expect(result).toMatchObject({ kind: "held", hold: { reason: "prepared ref rejected", deferralReason: "artifact" } });
    expect(effects.trace.calls).toEqual(["settle"]);
  });

  test("an absent standing artifact stops the loop without refreshing the protocol", async () => {
    const bound = input({ protocol: protocol({ presentArtifacts: [] }) });
    const effects = port({ settleExactArtifact: async () => ({ status: "absent" }) });
    const result = await settleStandingBranchProof(bound, effects);

    expect(result.kind).toBe("settled");
    expect(effects.trace.calls).toEqual([]);

    const standing = port({ settleExactArtifact: async () => ({ status: "absent" }) });
    const held = await settleStandingBranchProof(
      input({ protocol: protocol({ presentArtifacts: [preparedRef("refs/heads/main")] }) }),
      standing,
    );
    expect(standing.trace.calls).toEqual(["settle"]);
    expect(held).toMatchObject({ kind: "retry-exhausted", lastProof: { reason: "P settlement did not stabilize", passes: 1 } });
  });

  test("a moved artifact without an accepted receipt runs one bounded repair attempt bound to the movement", async () => {
    const effects = port({
      settleExactArtifact: async () => ({ status: "moved", reason: "reflog" }),
      runRepairAttempt: async () => ({ status: "restart", receipt: receipt("refs/heads/main"), discard: "plan-attestations-snapshots" }) satisfies PRepairAttemptResult,
    });
    const result = await settleStandingBranchProof(
      input({ protocol: protocol({ presentArtifacts: [preparedRef("refs/heads/main")] }), incomingRefScope: "branches" }),
      effects,
    );

    expect(effects.trace.calls).toEqual(["settle", "run-repair", "reload", "refresh-protocol"]);
    expect(effects.trace.repairs[0]).toMatchObject({
      stream: "stream-1",
      effectiveRefScope: "branches",
      repairAt: "1970-01-01T00:00:00.000Z",
      mismatches: { live: false, reflog: true, baseShape: false },
    });
    expect(result).toMatchObject({ kind: "settled", disposition: { passes: 1, outcomes: ["repaired"] } });
  });

  test("an accepted receipt resumes first and only refreshes the receipt when the resume asks for it", async () => {
    const accepted = receipt("refs/heads/main");
    const effects = port({
      settleExactArtifact: async () => ({ status: "moved", reason: "live" }),
      resumeAcceptedRepair: async () => ({ status: "refresh-receipt" }) satisfies PRepairResumeResult,
      refreshAcceptedRepair: async () => ({ status: "restart", receipt: accepted, discard: "plan-attestations-snapshots" }),
    });
    const result = await settleStandingBranchProof(
      input({
        protocol: protocol({ presentArtifacts: [preparedRef("refs/heads/main")] }),
        record: record(undefined, { "refs/heads/main": accepted }),
      }),
      effects,
    );

    expect(effects.trace.calls).toEqual(["inspect", "settle", "resume", "refresh-accepted", "reload", "refresh-protocol"]);
    expect(effects.trace.repairs[0]).toMatchObject({ mismatches: { live: true, reflog: false, baseShape: false } });
    expect(result.kind).toBe("settled");
  });

  test("a resumed restart never refreshes the accepted receipt", async () => {
    const accepted = receipt("refs/heads/main");
    const effects = port({
      settleExactArtifact: async () => ({ status: "moved", reason: "base-shape" }),
      resumeAcceptedRepair: async () => ({ status: "restart", receipt: accepted, discard: "plan-attestations-snapshots" }),
    });
    await settleStandingBranchProof(
      input({
        protocol: protocol({ presentArtifacts: [preparedRef("refs/heads/main")] }),
        record: record(undefined, { "refs/heads/main": accepted }),
      }),
      effects,
    );

    expect(effects.trace.calls).toEqual(["inspect", "settle", "resume", "reload", "refresh-protocol"]);
  });

  test("a resume hold is the repair hold and stops before any reload", async () => {
    const accepted = receipt("refs/heads/main");
    const effects = port({
      settleExactArtifact: async () => ({ status: "moved", reason: "live" }),
      resumeAcceptedRepair: async () => ({ status: "hold", reason: "accepted receipt Q/P coexistence" }),
    });
    const result = await settleStandingBranchProof(
      input({
        protocol: protocol({ presentArtifacts: [preparedRef("refs/heads/main")] }),
        record: record(undefined, { "refs/heads/main": accepted }),
      }),
      effects,
    );

    expect(result).toMatchObject({ kind: "held", hold: { reason: "accepted receipt Q/P coexistence", deferralReason: "artifact" } });
    expect(effects.trace.calls).toEqual(["inspect", "settle", "resume"]);
  });

  test("the accepted receipt is read from the record the freshest lineage projects, not the entry record", async () => {
    const p = preparedRef("refs/heads/main");
    const standing = protocol({ presentArtifacts: [p], artifacts: { "refs/heads/main": exactDisposition() } });
    const accepted = receipt("refs/heads/main");
    let settled = 0;
    const effects = port({
      settleExactArtifact: async () => {
        settled += 1;
        return settled === 1
          ? { status: "settled", state: { ...state(2), repoRecords: { [REL]: record(undefined, { "refs/heads/main": accepted }) } } as unknown as SyncState, ref: "refs/heads/main" }
          : { status: "moved", reason: "live" };
      },
      refreshProtocol: async () => ({ status: "ready", protocol: standing }),
      resumeAcceptedRepair: async () => ({ status: "hold", reason: "accepted receipt Q/P coexistence" }),
    });
    const result = await settleStandingBranchProof(input({ protocol: standing, retryBudget: 3 }), effects);

    expect(effects.trace.calls).toEqual(["settle", "refresh-protocol", "settle", "resume"]);
    expect(result).toMatchObject({ kind: "held", hold: { reason: "accepted receipt Q/P coexistence" } });
  });

  test("a repair retry re-plans without reloading state or refreshing the protocol", async () => {
    let attempts = 0;
    const effects = port({
      settleExactArtifact: async () => ({ status: "moved", reason: "live" }),
      runRepairAttempt: async () => {
        attempts += 1;
        return attempts === 1
          ? { status: "retry", reason: "observation-moved" }
          : { status: "restart", receipt: receipt("refs/heads/main"), discard: "plan-attestations-snapshots" };
      },
    });
    const result = await settleStandingBranchProof(
      input({ protocol: protocol({ presentArtifacts: [preparedRef("refs/heads/main")] }) }),
      effects,
    );

    expect(effects.trace.calls).toEqual(["settle", "run-repair", "settle", "run-repair", "reload", "refresh-protocol"]);
    expect(result).toMatchObject({ kind: "settled", disposition: { passes: 2, outcomes: ["retried", "repaired"] } });
  });

  test("a failed post-repair reload holds", async () => {
    const effects = port({
      settleExactArtifact: async () => ({ status: "moved", reason: "live" }),
      runRepairAttempt: async () => ({ status: "restart", receipt: receipt("refs/heads/main"), discard: "plan-attestations-snapshots" }),
      reloadState: async () => undefined,
    });
    const result = await settleStandingBranchProof(
      input({ protocol: protocol({ presentArtifacts: [preparedRef("refs/heads/main")] }) }),
      effects,
    );

    expect(result).toMatchObject({ kind: "held", hold: { reason: "P-repair state reload failed", deferralReason: "artifact" } });
  });

  test("a protocol hold after a settled pass keeps the already-durable carry", async () => {
    const settled = state(7);
    const reloaded = record(section("branches"));
    const effects = port({
      settleExactArtifact: async () => ({ status: "settled", state: { ...settled, repoRecords: { [REL]: reloaded } } as unknown as SyncState, ref: "refs/heads/main" }),
      refreshProtocol: async () => ({ status: "hold", reason: "malformed, colliding, or unclassifiable BASE artifact" }),
    });
    const result = await settleStandingBranchProof(
      input({ protocol: protocol({ presentArtifacts: [preparedRef("refs/heads/main")] }) }),
      effects,
    );

    expect(result).toMatchObject({
      kind: "held",
      hold: { reason: "malformed, colliding, or unclassifiable BASE artifact", deferralReason: "artifact" },
    });
    expect(result.carry.recoveredRecord).toEqual(reloaded);
    expect(result.carry.base).toEqual(reloaded.base);
  });

  test("the refreshed protocol is planned against the reloaded state, record, and BASE", async () => {
    const reloaded = record(section("branches"));
    const settled = { ...state(4), repoRecords: { [REL]: reloaded } } as unknown as SyncState;
    const effects = port({ settleExactArtifact: async () => ({ status: "settled", state: settled, ref: "refs/heads/main" }) });
    await settleStandingBranchProof(
      input({ protocol: protocol({ presentArtifacts: [preparedRef("refs/heads/main")] }), serializedBase: section("all"), record: record(section("all")) }),
      effects,
    );

    expect(effects.trace.refreshes[0]).toEqual({ state: settled, record: reloaded, base: reloaded.base });
  });

  test("a reload that no longer projects the repository keeps the prior record and BASE", async () => {
    const priorBase = section("all");
    const effects = port({ settleExactArtifact: async () => ({ status: "settled", state: state(4), ref: "refs/heads/main" }) });
    const result = await settleStandingBranchProof(
      input({ protocol: protocol({ presentArtifacts: [preparedRef("refs/heads/main")] }), serializedBase: priorBase, record: record(priorBase) }),
      effects,
    );

    expect(effects.trace.refreshes[0]?.base).toBe(priorBase);
    expect(result.carry.recoveredRecord).toBeUndefined();
    expect(result.carry.base).toBe(priorBase);
  });

  test("retry exhaustion stops at exactly the retry budget and names the unstabilized proof", async () => {
    const standing = protocol({ presentArtifacts: [preparedRef("refs/heads/main")] });
    const effects = port({
      settleExactArtifact: async () => ({ status: "settled", state: state(3), ref: "refs/heads/main" }),
      refreshProtocol: async () => ({ status: "ready", protocol: standing }),
    });
    const result = await settleStandingBranchProof(input({ protocol: standing, retryBudget: 3 }), effects);

    expect(effects.trace.calls.filter((call) => call === "settle")).toHaveLength(3);
    expect(result).toMatchObject({
      kind: "retry-exhausted",
      lastProof: {
        relPath: REL,
        incomingKey: INCOMING_KEY,
        reason: "P settlement did not stabilize",
        deferralReason: "artifact",
        passes: 3,
        standingArtifacts: 1,
      },
    });
  });

  test("each pass settles the head standing artifact of the freshest protocol", async () => {
    const first = preparedRef("refs/heads/one");
    const second = preparedRef("refs/heads/two");
    const effects = port({
      settleExactArtifact: async () => ({ status: "settled", state: state(3), ref: "x" }),
      refreshProtocol: async () => ({ status: "ready", protocol: protocol({ presentArtifacts: [second] }) }),
    });
    const result = await settleStandingBranchProof(
      input({ protocol: protocol({ presentArtifacts: [first, second] }), retryBudget: 2 }),
      effects,
    );

    expect(effects.trace.settles.map((entry) => entry.ref)).toEqual(["refs/heads/one", "refs/heads/two"]);
    expect(result.kind).toBe("retry-exhausted");
  });

  test("the settlement binding is the freshest protocol's binding, never the artifact payload", async () => {
    const refreshed = { lineageHash: "n".repeat(64), repositoryIdentityHash: "m".repeat(64) } as unknown as ArtifactBinding;
    const effects = port({
      settleExactArtifact: async () => ({ status: "settled", state: state(3), ref: "x" }),
      refreshProtocol: async () => ({ status: "ready", protocol: protocol({ binding: refreshed, presentArtifacts: [preparedRef("refs/heads/two")] }) }),
    });
    await settleStandingBranchProof(
      input({ protocol: protocol({ presentArtifacts: [preparedRef("refs/heads/one")] }), retryBudget: 2 }),
      effects,
    );

    expect(effects.trace.settles.map((entry) => entry.binding)).toEqual([BINDING, refreshed]);
  });

  describe("prepared-ref revalidation", () => {
    async function validate(overrides: {
      artifact?: ArtifactReadResult<BasePresentPayload>;
      disposition?: FollowerBranchProtocol["artifacts"][string];
      noDisposition?: boolean;
    }): Promise<boolean> {
      const p = preparedRef("refs/heads/main");
      let captured: (() => Promise<boolean>) | undefined;
      const effects = port({
        settleExactArtifact: async () => ({ status: "moved", reason: "live" }),
        readStandingArtifact: async () => overrides.artifact
          ?? ({ status: "valid", artifact: { targetOid: p.targetOid, payload: p.payload } } as unknown as ArtifactReadResult<BasePresentPayload>),
        runRepairAttempt: async (attempt) => {
          captured = attempt.validateArtifacts;
          return { status: "hold", reason: "stop" };
        },
      });
      await settleStandingBranchProof(
        input({
          protocol: protocol({
            presentArtifacts: [p],
            artifacts: overrides.noDisposition
              ? {}
              : { "refs/heads/main": overrides.disposition ?? exactDisposition() },
          }),
        }),
        effects,
      );
      if (!captured) throw new Error("repair attempt never received a revalidation callback");
      return captured();
    }

    test("accepts only an exactly owning, exactly kept, unclaimed-absence artifact at the prepared target", async () => {
      expect(await validate({})).toBe(true);
    });

    test("rejects an artifact that no longer reads valid", async () => {
      expect(await validate({ artifact: { status: "absent" } as unknown as ArtifactReadResult<BasePresentPayload> })).toBe(false);
    });

    test("rejects an artifact that moved off the prepared target", async () => {
      expect(await validate({
        artifact: { status: "valid", artifact: { targetOid: "9".repeat(40) } } as unknown as ArtifactReadResult<BasePresentPayload>,
      })).toBe(false);
    });

    test("rejects a missing disposition", async () => {
      expect(await validate({ noDisposition: true })).toBe(false);
    });

    for (const [field, value] of [
      ["present", "active-foreign"],
      ["keeps", "mismatched"],
      ["absence", "valid-owning"],
      ["settledAbsence", "valid-owning"],
    ] as const) {
      test(`rejects a disposition whose ${field} is ${value}`, async () => {
        expect(await validate({ disposition: { ...exactDisposition(), [field]: value } })).toBe(false);
      });
    }
  });
});
