/**
 * `worktree-squash-lifecycle` — design 200's acceptance gate, encoded end to end.
 * **EXPECTED RED on current main.** The failing assertions ARE the deliverable: they
 * are the executable form of the founder's ruling that a full agent lifecycle —
 * create worktree → branch → commit → squash-merge to main → delete branch +
 * worktree — must leave **zero surviving deferrals** on every device.
 *
 * The two wedge classes it reproduces (docs/design/200 §1, observed 2026-07-24 on the
 * founder's Mac):
 *
 *   **mode (a) — worktree ownership hold.** A linked worktree holding a branch makes
 *   that branch's incoming transition unownable. Holding that ONE ref is legitimate —
 *   something genuinely has it checked out — but `src/cli/sync-git/apply.ts:1447-1450`
 *   escalates any nonempty `heldRefs` into `pending[rel] = remoteSec` +
 *   `setDeferral(rel, "apply", …)`, i.e. a WHOLE-REPOSITORY capture gag. Design 200 P2
 *   is the no-escalation fix; the phase-1 assertions here name it.
 *
 *   **mode (b) — phantom ref.** A branch that was published (BASE positive via a
 *   `publisher-ack` origin), squash-merged (so ancestry can NEVER prove it merged), and
 *   then deleted locally leaves BASE positive forever. The transition planner throws
 *   `branch transition does not match logical BASE pre-state`
 *   (`src/cli/sync-git/branch-transition.ts:105`) on every subsequent cycle, and
 *   `plan.ts:788` carries `pending` forever with `local repository lacks pending ref …`.
 *   There is no manual exit (§2.4). The phase-2 assertions name it.
 *
 * Acceptance semantics (founder ruling, 2026-07-24): **the clearing event is worktree
 * DELETION, not the squash-merge.** While the worktree lives, a per-ref hold is correct;
 * only the escalation is a defect. Phase 2 — after `git worktree remove` +
 * `git branch -D` — is the gate proper. The squash-merge earlier in the lifecycle is
 * what makes that deletion the hard case (`git branch --merged main` never lists the
 * branch), but every gate assertion hangs off the deletion.
 *
 * Fixture shape, and why each step is load-bearing:
 *   1. A seeds `repo-200` (`main`, one commit); provisionPair converges both devices.
 *   2. A runs the real agent layout: `git worktree add .claude/worktrees/feat -b
 *      feat/agent-work` INSIDE the repo, commits there. One round-trip publishes the
 *      branch — this is what puts `refs/heads/feat/agent-work` into A's BASE with a
 *      `publisher-ack` origin, the precondition for the phantom.
 *   3. A squash-merges the branch into `main` on the main checkout. Asserted: the branch
 *      tip is NOT an ancestor of `main` (the whole point — pure-ancestry merged-ness,
 *      `reachability.ts:113-121`, can never retire it).
 *   4. **Divergence, required for the hold to be reachable at all.** `follow.ts` skips
 *      any candidate whose incoming value equals its local value (`if (oldOid === newOid)
 *      continue`), so a repo whose only writer is A never fires the ownership hold. The
 *      rig therefore does what the fleet does: the agent keeps committing in its worktree
 *      (tip advances, unpublished) while the peer publishes unrelated Git work. A's next
 *      pull then sees the held branch at a DIFFERENT value than its local tip.
 *   5. Phase 1 (worktree alive) asserts the no-escalation contract.
 *   6. A removes the worktree and deletes the branch — the founder's clearing event.
 *   7. Phase 2 asserts the gate over N explicit round-trips, then over a live-daemon
 *      settle window (the compressed form of "no deferral survives the 24h soak").
 *
 * Assertion posture matches the other git scenarios: PATH and persisted STATE, not
 * milliseconds. Every wall-clock bound is a generous backstop; the mode-named state and
 * log-line assertions are what catch a regression. Forbidden-line checks are windowed:
 * `checked out in linked worktree` is legitimate while the worktree lives and is only
 * forbidden AFTER its removal; the pre-state throw is never legitimate anywhere.
 *
 * MANUAL / explicit-only — NOT in FAST_SUITE, and deliberately not wired into any CI
 * workflow. It is red by construction until design 200 lands:
 *
 *   bun run rig run worktree-squash-lifecycle
 */
import { GUEST } from "../lib/config.js";
import { pollUntil } from "../lib/waiters.js";
import type { Device } from "../lib/device.js";
import { createRecorder, errMsg } from "./harness.js";
import type { Recorder } from "./harness.js";
import { CONCURRENCY, provisionPair, startDaemons, teardownAccount } from "./preamble.js";
import type { RigCtx, Scenario, ScenarioReport } from "./types.js";
import { finalizeReport } from "./types.js";

const REPO = "repo-200";
const BRANCH = "feat/agent-work";
const BRANCH_REF = `refs/heads/${BRANCH}`;
/** The founder's real agent layout: a linked worktree INSIDE the synced repository. */
const WORKTREE_REL = ".claude/worktrees/feat";
/** Unrelated Git work published by the follower — the divergence that makes the
 *  ownership hold reachable (see the header, step 4). */
const PEER_BRANCH = "follower/probe";

const repoDir = `${GUEST.workDir}/${REPO}`;
const worktreeDir = `${repoDir}/${WORKTREE_REL}`;

/** How many explicit A↔B round-trips the post-deletion gate gets before it fails.
 *  Generous: convergence needs one round-trip; four leaves room for a slow-path
 *  fall-through to still converge, so the assertion catches a WEDGE, not a race. */
const GATE_CYCLES = 4;
/** Bounded live-daemon settle window after the explicit cycles — the compressed form
 *  of the 24h zero-deferral soak. Polls out early the moment both devices settle. */
const SOAK_TIMEOUT_MS = 90_000;
const SOAK_POLL_MS = 3_000;

const IDENT = `-c user.name='Rig Tester' -c user.email='rig@example.com'`;

/** Deterministic identity + per-commit date pin so reruns mint stable shas. */
const detScript = (body: string): string => `
set -e
export GIT_AUTHOR_NAME='Rig Tester' GIT_AUTHOR_EMAIL='rig@example.com'
export GIT_COMMITTER_NAME='Rig Tester' GIT_COMMITTER_EMAIL='rig@example.com'
D() { export GIT_AUTHOR_DATE="$1T00:00:00 +0000" GIT_COMMITTER_DATE="$1T00:00:00 +0000"; }
${body}`.replace(/git /g, `git ${IDENT} `);

// ── persisted-state views (same loose-read idiom as git-ff / git-join-ahead) ────

interface GitSectionView {
  head?: string;
  refs?: Record<string, string>;
}

interface RepoRecordView {
  base?: GitSectionView;
  advertised?: GitSectionView;
  pending?: GitSectionView | null;
  partial?: { heldRefs?: Record<string, string>; appliedRefs?: Record<string, unknown> } | null;
  deferrals?: Record<string, { reason?: string; deferredSince?: string } | undefined>;
}

interface SyncStateView {
  repoRecords?: Record<string, RepoRecordView>;
  gitPendingRemote?: Record<string, unknown>;
  gitNeedsResolution?: Record<string, unknown>;
}

async function readSyncState(device: Device): Promise<SyncStateView> {
  const raw = JSON.parse(await device.readFile(`${GUEST.workDir}/.rbox/state.json`)) as SyncStateView & { syncState?: SyncStateView };
  return raw.repoRecords ? raw : raw.syncState ?? raw;
}

/**
 * Every deferral the device is carrying, across EVERY repository record, as sorted
 * `<repo>/<lane>=<reason>` tokens — plus any `gitNeedsResolution` entry (a repo that
 * needs `rbox git resolve` is a surviving deferral by any user-visible measure). The
 * founder's gate is "zero", so the whole set is the assertion subject, not one repo.
 * PURE over the parsed state.
 */
function deferralTokens(state: SyncStateView): string[] {
  const tokens: string[] = [];
  for (const [repo, record] of Object.entries(state.repoRecords ?? {})) {
    for (const [lane, deferral] of Object.entries(record.deferrals ?? {})) {
      if (deferral) tokens.push(`${repo}/${lane}=${deferral.reason ?? "?"}`);
    }
  }
  for (const repo of Object.keys(state.gitNeedsResolution ?? {})) tokens.push(`${repo}/needs-resolution`);
  return tokens.sort();
}

/** Sorted ref names of a persisted git section (`{}` → []). PURE. */
function refNames(section: GitSectionView | null | undefined): string[] {
  return Object.keys(section?.refs ?? {}).sort();
}

/** Compact one-line evidence string for a repo record. PURE. */
function recordSummary(state: SyncStateView, repo: string): string {
  const record = state.repoRecords?.[repo];
  if (!record) return `${repo}: (no record)`;
  const held = Object.entries(record.partial?.heldRefs ?? {}).map(([ref, why]) => `${ref}=${why}`);
  return [
    `${repo}:`,
    `base.refs=[${refNames(record.base).join(" ")}]`,
    `pending=${record.pending ? `[${refNames(record.pending).join(" ")}]` : "absent"}`,
    `heldRefs=[${held.join(" ")}]`,
    `deferrals=${JSON.stringify(record.deferrals ?? {})}`,
  ].join(" ");
}

// ── guest git probes ───────────────────────────────────────────────────────────

async function gitRev(dev: Device, rev: string, dir = repoDir): Promise<string> {
  const r = await dev.exec(["git", "-C", dir, "rev-parse", "--verify", "--quiet", rev], { allowFail: true });
  return r.exitCode === 0 ? r.stdout.trim() : "";
}

async function isAncestor(dev: Device, ancestor: string, descendant: string): Promise<boolean> {
  const r = await dev.exec(["git", "-C", repoDir, "merge-base", "--is-ancestor", ancestor, descendant], { allowFail: true });
  return r.exitCode === 0;
}

async function worktreeBranches(dev: Device): Promise<string> {
  const r = await dev.exec(["sh", "-c", `git -C '${repoDir}' worktree list --porcelain`], { allowFail: true });
  return r.exitCode === 0 ? r.stdout.trim() : "";
}

async function conflictRefCount(dev: Device): Promise<number> {
  const r = await dev.exec(["sh", "-c", `git -C '${repoDir}' for-each-ref refs/rbox-conflict | wc -l`], { allowFail: true });
  const n = Number(r.stdout.trim());
  return r.exitCode === 0 && Number.isFinite(n) ? n : -1;
}

/** Seed `repo-200` on A BEFORE `init --new`, so the first sync captures it. */
async function seedRepo(a: Device): Promise<void> {
  await a.exec(["sh", "-c", detScript(`
mkdir -p '${repoDir}'
cd '${repoDir}'
git init -q -b main
printf 'base\\n' > README.md
D 2026-01-01; git add README.md && git commit -q -m 'initial commit'
`)]);
}

// ── forbidden log lines (the design-200 field signatures) ──────────────────────

/** mode (b), `branch-transition.ts:105` — never legitimate, anywhere. */
const PRESTATE_RE = /branch transition does not match logical BASE pre-state/;
/** mode (b), `plan.ts:788` — the forever-carry line naming the phantom ref. */
const PENDING_CARRY_RE = new RegExp(`local repository lacks pending ref ${BRANCH_REF.replace(/\//g, "\\/")}`);
/** mode (a), `follow.ts:710/737` — LEGITIMATE while the worktree lives; forbidden after. */
const LINKED_WORKTREE_RE = /is checked out in linked worktree/;

function matchingLines(text: string, re: RegExp): string[] {
  return text.split("\n").filter((line) => re.test(line)).map((line) => line.trim());
}

export const worktreeSquashLifecycle: Scenario = {
  name: "worktree-squash-lifecycle",
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    const rec: Recorder = createRecorder(ctx);
    const startedAt = new Date().toISOString();

    /** Every sync command's combined output, in order — the assertion subject for the
     *  forbidden-line checks. `sink.length` is a window mark (see the header). */
    const sink: string[] = [];
    const sinkText = (from = 0): string => sink.slice(from).join("\n");
    /** Nonzero sync exits. A deferral is NEVER a nonzero exit, so any entry here means
     *  the rig itself misdrove the CLI (the maiden run passed `--verbose` to `push`,
     *  which rejects it — every push failed and the "red" was an artifact). Asserted. */
    const syncFailures: string[] = [];

    const sync = async (dev: Device, label: string, verb: "push" | "pull"): Promise<string> => {
      // `--verbose` is a PULL-only flag (`main-dispatch.ts:328`) — `rbox push` rejects it.
      // The push lane also never wires `onGitLog` (`sync-cmd.ts:19` is pull-only), so the
      // capture lane's per-repo forensics reach the DAEMON LOG only. That asymmetry is why
      // the soak's daemon-log check below is load-bearing, not decorative.
      const argv = verb === "push" ? ["push"] : ["pull", "--verbose"];
      const env: Record<string, string> = { RBOX_DEBUG: "1" };
      env[verb === "push" ? "RBOX_UPLOAD_CONCURRENCY" : "RBOX_DOWNLOAD_CONCURRENCY"] = CONCURRENCY;
      const res = await dev.rbox(argv, { cwd: GUEST.workDir, env, allowFail: true });
      const text = `${res.stdout}\n${res.stderr}`;
      sink.push(`── ${label} rbox ${verb} (exit ${res.exitCode}) ──\n${text}`);
      if (res.exitCode !== 0) {
        syncFailures.push(`${label} ${verb} exit ${res.exitCode}: ${res.stderr.trim().split("\n").slice(-1)[0] ?? ""}`);
        ctx.log(`  (${label} rbox ${verb} exited ${res.exitCode} — recorded, asserted at the end)`);
      }
      return text;
    };

    /**
     * One full A↔B round-trip. B pushes too: the follower republishing its own section
     * is what gives A an INCOMING section to follow, which is the only way either wedge
     * class is reachable (see header step 4). Exactly the fleet's steady rhythm.
     */
    const roundTrip = async (label: string): Promise<void> => {
      await sync(ctx.a, `[A] ${label}`, "push");
      await sync(ctx.b, `[B] ${label}`, "pull");
      await sync(ctx.b, `[B] ${label}`, "push");
      await sync(ctx.a, `[A] ${label}`, "pull");
    };

    const logState = async (label: string): Promise<void> => {
      const [sa, sb] = await Promise.all([readSyncState(ctx.a), readSyncState(ctx.b)]);
      ctx.log(`  ${label} — A deferrals [${deferralTokens(sa).join(" ")}] · ${recordSummary(sa, REPO)}`);
      ctx.log(`  ${label} — B deferrals [${deferralTokens(sb).join(" ")}] · ${recordSummary(sb, REPO)}`);
    };

    try {
      // ── 1. converged baseline ────────────────────────────────────────────────
      await provisionPair(ctx, rec, { afterSeedA: seedRepo });
      const mainInitial = await gitRev(ctx.a, "main");
      await rec.step("baseline: repo-200 converged on both devices", async () => {
        const bMain = await gitRev(ctx.b, "main");
        if (!mainInitial || mainInitial !== bMain) {
          throw new Error(`baseline diverged (A main=${mainInitial.slice(0, 12)} B main=${bMain.slice(0, 12) || "(none)"})`);
        }
      });

      // ── 2. the agent lifecycle: worktree + branch + commit, then publish ─────
      let branchTip1 = "";
      await rec.step(`[A] git worktree add ${WORKTREE_REL} -b ${BRANCH} + commit`, async () => {
        await ctx.a.exec(["sh", "-c", detScript(`
cd '${repoDir}'
git worktree add -q '${WORKTREE_REL}' -b '${BRANCH}'
cd '${worktreeDir}'
printf 'agent work 1\\n' > agent.txt
D 2026-02-01; git add agent.txt && git commit -q -m 'agent work 1'
`)]);
        branchTip1 = await gitRev(ctx.a, BRANCH);
        if (!branchTip1) throw new Error(`${BRANCH} unreadable after the worktree commit`);
      });
      rec.assert(`fixture: linked worktree registered on A for ${BRANCH}`,
        (await worktreeBranches(ctx.a)).includes(`branch ${BRANCH_REF}`),
        (await worktreeBranches(ctx.a)).replace(/\n/g, " · "));

      await rec.step("round-trip 1: the branch publishes (BASE gains the ref)", async () => {
        await roundTrip("publish-branch");
      });
      const baseAfterPublish = await readSyncState(ctx.a);
      rec.assert(`fixture: A BASE carries ${BRANCH_REF} after publication (phantom precondition)`,
        refNames(baseAfterPublish.repoRecords?.[REPO]?.base).includes(BRANCH_REF),
        `A base.refs=[${refNames(baseAfterPublish.repoRecords?.[REPO]?.base).join(" ")}]`);
      rec.assert(`fixture: B materialized ${BRANCH} at A's tip`,
        (await gitRev(ctx.b, BRANCH)) === branchTip1,
        `A=${branchTip1.slice(0, 12)} B=${(await gitRev(ctx.b, BRANCH)).slice(0, 12) || "(none)"}`);
      await logState("after publish");

      // ── 3. squash-merge on the main checkout ────────────────────────────────
      let squashSha = "";
      await rec.step(`[A] git merge --squash ${BRANCH} && git commit on main`, async () => {
        await ctx.a.exec(["sh", "-c", detScript(`
cd '${repoDir}'
git merge --squash '${BRANCH}'
D 2026-02-02; git commit -q -m 'squash-merge ${BRANCH}'
`)]);
        squashSha = await gitRev(ctx.a, "main");
        if (!squashSha) throw new Error("main unreadable after the squash-merge");
      });
      rec.assert(`fixture: ${BRANCH} tip is NOT an ancestor of the squash commit (ancestry cannot prove merged)`,
        !(await isAncestor(ctx.a, branchTip1, squashSha)),
        `branch=${branchTip1.slice(0, 12)} main=${squashSha.slice(0, 12)}`);
      await rec.step("round-trip 2: the squash commit publishes", async () => {
        await roundTrip("publish-squash");
      });
      rec.assert("fixture: B followed the squash commit on main",
        (await gitRev(ctx.b, "main")) === squashSha,
        `A=${squashSha.slice(0, 12)} B=${(await gitRev(ctx.b, "main")).slice(0, 12) || "(none)"}`);

      // ── 4. divergence: the agent keeps working; the peer publishes elsewhere ──
      // Without this the ownership hold is UNREACHABLE (follow.ts skips a candidate
      // whose incoming value equals its local value), so phase 1 would assert nothing.
      let branchTip2 = "";
      let peerTip = "";
      await rec.step(`[A] ref-only worktree advance (unpublished) + [B] unrelated branch ${PEER_BRANCH}`, async () => {
        // `--allow-empty`: advance the held branch's TIP without touching any synced
        // file, so A's working tree stays clean. A dirty tree would defer the checkout
        // plane for `local-edits`, which outranks `worktree-ownership`
        // (GIT_DEFERRAL_REASON_PRECEDENCE) and would blur which mode this red names.
        await ctx.a.exec(["sh", "-c", detScript(`
cd '${worktreeDir}'
D 2026-02-03; git commit -q --allow-empty -m 'agent work 2 (ref-only advance)'
`)]);
        branchTip2 = await gitRev(ctx.a, BRANCH);
        await ctx.b.exec(["sh", "-c", detScript(`
cd '${repoDir}'
git switch -q -c '${PEER_BRANCH}'
printf 'peer probe\\n' > peer.txt
D 2026-02-04; git add peer.txt && git commit -q -m 'unrelated peer work'
git switch -q main
`)]);
        peerTip = await gitRev(ctx.b, PEER_BRANCH);
        if (!branchTip2 || branchTip2 === branchTip1) throw new Error("A's second worktree commit did not advance the branch");
        if (!peerTip) throw new Error("B's unrelated branch was not created");
      });

      // The hold precondition, stated as fixture facts independent of rbox's response:
      // A's live tip for the held ref differs from the value the peer is advertising.
      const holdWindow = sink.length;
      await rec.step("[B] publishes the unrelated work; [A] pulls into the live worktree hold", async () => {
        await sync(ctx.b, "[B] arm-hold", "push");
        await sync(ctx.a, "[A] arm-hold", "pull");
      });
      const heldState = await readSyncState(ctx.a);
      await logState("hold window");
      ctx.log(`  hold-window A sync output:\n${sinkText(holdWindow).split("\n").filter((l) => /git-sync|deferred|held/.test(l)).join("\n")}`);
      rec.assert("fixture: A's held-ref tip differs from the peer-advertised value (hold precondition)",
        branchTip2 !== branchTip1 && (await gitRev(ctx.b, BRANCH)) === branchTip1,
        `A live=${branchTip2.slice(0, 12)} peer=${branchTip1.slice(0, 12)}`);

      // ── 5. Phase 1 (worktree ALIVE) — design 200 P2's no-escalation contract ──
      // Holding the ONE ref is legitimate here; escalating it is not.
      const heldRecord = heldState.repoRecords?.[REPO];
      rec.assert("P2 no-escalation: repo must not carry a whole-repo apply deferral while one ref is held",
        heldRecord?.deferrals?.apply === undefined,
        `A deferrals=${JSON.stringify(heldRecord?.deferrals ?? {})} (heldRefs=${JSON.stringify(heldRecord?.partial?.heldRefs ?? {})})`);
      // RELAXED per design 200 §9.6 (R5: P4 cut): holding a divergent ref for a
      // live worktree's lifetime is legitimate, and the carried WHOLE pending
      // section is its bookkeeping — the per-ref split lives in record.partial.
      // Design 201 reverses this relaxation. The section must still disappear
      // after the worktree+branch go (asserted by the post-deletion gate below).
      rec.assert("P2 no-escalation (relaxed): a carried pending section is bookkeeping — partial must split it per-ref",
        heldRecord?.pending === undefined || heldRecord?.pending === null
          || (Object.keys(heldRecord?.partial?.heldRefs ?? {}).includes(BRANCH_REF)
            && Object.keys(heldRecord?.partial?.appliedRefs ?? {}).some((r) => r !== BRANCH_REF)),
        `pending.refs=[${refNames(heldRecord?.pending ?? undefined).join(" ")}] heldRefs=${JSON.stringify(heldRecord?.partial?.heldRefs ?? {})} appliedRefs=${JSON.stringify(heldRecord?.partial?.appliedRefs ?? [])}`);
      rec.assert("P2 no-escalation: unrelated incoming ref applies while one ref is held",
        (await gitRev(ctx.a, PEER_BRANCH)) === peerTip,
        `A ${PEER_BRANCH}=${(await gitRev(ctx.a, PEER_BRANCH)).slice(0, 12) || "(absent)"} want=${peerTip.slice(0, 12)}`);

      let unrelatedSha = "";
      await rec.step("[A] unrelated commit on main must sync past the live worktree hold", async () => {
        await ctx.a.exec(["sh", "-c", detScript(`
cd '${repoDir}'
printf 'unrelated main work\\n' > unrelated.txt
D 2026-02-05; git add unrelated.txt && git commit -q -m 'unrelated work on main'
`)]);
        unrelatedSha = await gitRev(ctx.a, "main");
        await roundTrip("unrelated-past-hold");
      });
      rec.assert("P2 no-escalation: unrelated change on main must still propagate A→B past a live worktree hold",
        unrelatedSha !== "" && (await gitRev(ctx.b, "main")) === unrelatedSha,
        `A main=${unrelatedSha.slice(0, 12)} B main=${(await gitRev(ctx.b, "main")).slice(0, 12) || "(none)"}`);
      await logState("after unrelated commit");

      // ── 6a. re-arm the gag — the field's mode (a) → mode (b) bridge (§1.5) ────
      // "While capture is gagged the user keeps deleting merged branches. Each such
      // deletion becomes a phantom ref." The phase-1 propagation round above healed the
      // gag (design 174 supersession), so re-establish it and then delete with NO
      // intervening cycle: that is the only ordering in which `pending` still carries the
      // branch at deletion time, which is what produces §1.2's
      // `branch transition does not match logical BASE pre-state` rather than §2.3's
      // milder stale-BASE variant. Both are mode (b); the field hit the former.
      await rec.step("[A] re-arm the worktree gag (agent commits again; peer publishes)", async () => {
        await ctx.a.exec(["sh", "-c", detScript(`
cd '${worktreeDir}'
D 2026-02-06; git commit -q --allow-empty -m 'agent work 3 (ref-only advance)'
`)]);
        await ctx.b.exec(["sh", "-c", detScript(`
cd '${repoDir}'
git switch -q '${PEER_BRANCH}'
D 2026-02-07; git commit -q --allow-empty -m 'more unrelated peer work'
git switch -q main
`)]);
        await sync(ctx.b, "[B] rearm", "push");
        await sync(ctx.a, "[A] rearm", "pull");
      });
      const rearmed = await readSyncState(ctx.a);
      await logState("re-armed gag");
      rec.assert(`fixture: the capture gag is outstanding at deletion time (pending carries ${BRANCH_REF})`,
        refNames(rearmed.repoRecords?.[REPO]?.pending).includes(BRANCH_REF),
        `A pending=${rearmed.repoRecords?.[REPO]?.pending ? `[${refNames(rearmed.repoRecords?.[REPO]?.pending).join(" ")}]` : "absent"}`);

      // ── 6b. the clearing event: worktree removal + branch deletion ───────────
      const gateWindow = sink.length;
      await rec.step(`[A] git worktree remove ${WORKTREE_REL} && git branch -D ${BRANCH}`, async () => {
        await ctx.a.exec(["sh", "-c", detScript(`
cd '${repoDir}'
git worktree remove '${WORKTREE_REL}'
git branch -D '${BRANCH}'
`)]);
        if (await gitRev(ctx.a, BRANCH)) throw new Error(`${BRANCH} still present on A after git branch -D`);
        if ((await worktreeBranches(ctx.a)).includes(BRANCH_REF)) throw new Error("the linked worktree survived removal");
      });

      // ── 7. Phase 2 — THE GATE. Zero surviving deferrals, converged refs, no phantom.
      let cyclesUsed = 0;
      let gateA: string[] = [];
      let gateB: string[] = [];
      await rec.step(`post-deletion gate: up to ${GATE_CYCLES} explicit round-trips`, async () => {
        for (let i = 1; i <= GATE_CYCLES; i++) {
          cyclesUsed = i;
          await roundTrip(`gate-${i}`);
          const [sa, sb] = await Promise.all([readSyncState(ctx.a), readSyncState(ctx.b)]);
          gateA = deferralTokens(sa);
          gateB = deferralTokens(sb);
          const converged = (await gitRev(ctx.a, BRANCH)) === "" && (await gitRev(ctx.b, BRANCH)) === ""
            && (await gitRev(ctx.a, "main")) === (await gitRev(ctx.b, "main"));
          ctx.log(`  gate cycle ${i}: A deferrals [${gateA.join(" ")}] · B deferrals [${gateB.join(" ")}] · refsConverged=${converged}`);
          if (converged && gateA.length === 0 && gateB.length === 0) break;
        }
      });
      await logState("after gate cycles");

      rec.assert(`post-deletion gate: zero deferrals on A within ${GATE_CYCLES} cycles after worktree removal`,
        gateA.length === 0, gateA.length ? `A still deferring after ${cyclesUsed} cycle(s): ${gateA.join(" ")}` : "none");
      rec.assert(`post-deletion gate: zero deferrals on B within ${GATE_CYCLES} cycles after worktree removal`,
        gateB.length === 0, gateB.length ? `B still deferring after ${cyclesUsed} cycle(s): ${gateB.join(" ")}` : "none");

      const aBranch = await gitRev(ctx.a, BRANCH);
      const bBranch = await gitRev(ctx.b, BRANCH);
      const aMain = await gitRev(ctx.a, "main");
      const bMain = await gitRev(ctx.b, "main");
      rec.assert(`post-deletion gate: ${BRANCH} absent on A`, aBranch === "", aBranch.slice(0, 12) || "absent");
      rec.assert(`post-deletion gate: ${BRANCH} absent on B (the deletion published)`,
        bBranch === "", bBranch ? `B still holds ${BRANCH}=${bBranch.slice(0, 12)} — the local deletion never published` : "absent");
      rec.assert("post-deletion gate: main tips equal on A and B",
        aMain !== "" && aMain === bMain, `A=${aMain.slice(0, 12)} B=${bMain.slice(0, 12) || "(none)"}`);

      const finalA = await readSyncState(ctx.a);
      const finalRecord = finalA.repoRecords?.[REPO];
      rec.assert(`mode (b) phantom ref: A BASE must not contain ${BRANCH_REF}`,
        !refNames(finalRecord?.base).includes(BRANCH_REF),
        refNames(finalRecord?.base).includes(BRANCH_REF)
          ? `BASE still positive for ${BRANCH_REF} @ ${(finalRecord?.base?.refs?.[BRANCH_REF] ?? "?").slice(0, 12)} — squash-merge means ancestry can never retire it`
          : `base.refs=[${refNames(finalRecord?.base).join(" ")}]`);
      rec.assert(`mode (b) phantom ref: A pending must not contain ${BRANCH_REF}`,
        !refNames(finalRecord?.pending).includes(BRANCH_REF),
        finalRecord?.pending ? `pending.refs=[${refNames(finalRecord.pending).join(" ")}]` : "pending absent");

      const gateText = sinkText(gateWindow);
      const prestateHits = matchingLines(sinkText(), PRESTATE_RE);
      rec.assert("mode (b) phantom ref: no `branch transition does not match logical BASE pre-state` in any sync output",
        prestateHits.length === 0,
        prestateHits.length ? `${prestateHits.length} line(s), first: ${prestateHits[0]!.slice(0, 220)}` : "none");
      const carryHits = matchingLines(gateText, PENDING_CARRY_RE);
      rec.assert(`mode (b) phantom ref: no \`local repository lacks pending ref ${BRANCH_REF}\` carry after deletion`,
        carryHits.length === 0,
        carryHits.length ? `${carryHits.length} line(s), first: ${carryHits[0]!.slice(0, 220)}` : "none");
      const worktreeHits = matchingLines(gateText, LINKED_WORKTREE_RE);
      rec.assert("mode (a) worktree hold: no `checked out in linked worktree` line after the worktree is removed",
        worktreeHits.length === 0,
        worktreeHits.length ? `${worktreeHits.length} line(s), first: ${worktreeHits[0]!.slice(0, 220)}` : "none");

      // ── 8. live-daemon settle window — "no deferral survives the final cycle" ──
      await startDaemons(ctx, rec);
      let soakA: string[] = [];
      let soakB: string[] = [];
      await rec.step(`soak: bounded live-daemon settle window (<=${SOAK_TIMEOUT_MS / 1000}s)`, async () => {
        const out = await pollUntil({
          probe: async () => {
            const [sa, sb] = await Promise.all([readSyncState(ctx.a), readSyncState(ctx.b)]);
            soakA = deferralTokens(sa);
            soakB = deferralTokens(sb);
            return soakA.length === 0 && soakB.length === 0;
          },
          done: (settled) => settled === true,
          timeoutMs: SOAK_TIMEOUT_MS,
          intervalMs: SOAK_POLL_MS,
        });
        ctx.log(`  soak settled=${out.ok} after ${(out.elapsedMs / 1000).toFixed(1)}s (${out.attempts} probes)`);
      });
      rec.assert("soak: no deferral survives the live-daemon settle window on A",
        soakA.length === 0, soakA.join(" ") || "none");
      rec.assert("soak: no deferral survives the live-daemon settle window on B",
        soakB.length === 0, soakB.join(" ") || "none");

      const [daemonA, daemonB] = await Promise.all([ctx.a.readDaemonLogs(GUEST.rboxHome), ctx.b.readDaemonLogs(GUEST.rboxHome)]);
      const daemonText = `${daemonA}\n${daemonB}`;
      const daemonPrestate = matchingLines(daemonText, PRESTATE_RE);
      const daemonWorktree = matchingLines(daemonText, LINKED_WORKTREE_RE);
      rec.assert("soak: no `branch transition does not match logical BASE pre-state` in either daemon log",
        daemonPrestate.length === 0,
        daemonPrestate.length ? `${daemonPrestate.length} line(s), first: ${daemonPrestate[0]!.slice(0, 220)}` : "none");
      rec.assert("soak: no `checked out in linked worktree` line in either daemon log (the worktree is gone)",
        daemonWorktree.length === 0,
        daemonWorktree.length ? `${daemonWorktree.length} line(s), first: ${daemonWorktree[0]!.slice(0, 220)}` : "none");

      // ── controls ─────────────────────────────────────────────────────────────
      // Fixture integrity first: a deferral is never a nonzero exit, so a failed sync
      // means the rig misdrove the CLI and every verdict above is worthless.
      rec.assert("control: every rig sync invocation exited 0 (fixture integrity)",
        syncFailures.length === 0, syncFailures.join(" · ") || "none");
      rec.assert("control: no refs/rbox-conflict/* on A", (await conflictRefCount(ctx.a)) === 0,
        "the lifecycle must not mint conflict refs");
      rec.assert("control: no refs/rbox-conflict/* on B", (await conflictRefCount(ctx.b)) === 0,
        "the lifecycle must not mint conflict refs");
      const statusA = await ctx.a.exec(["git", "-C", repoDir, "status", "--porcelain"], { allowFail: true });
      rec.assert("control: A working tree clean at the end", statusA.exitCode === 0 && statusA.stdout.trim() === "",
        statusA.stdout.trim().replace(/\n/g, " · ") || "clean");
      // Converged, not pinned to a literal sha: the re-arm advances this branch again, so
      // the invariant is "present and equal on both devices", never a captured constant.
      const peerA = await gitRev(ctx.a, PEER_BRANCH);
      const peerB = await gitRev(ctx.b, PEER_BRANCH);
      rec.assert(`control: unrelated peer branch ${PEER_BRANCH} intact and converged on both devices`,
        peerA !== "" && peerA === peerB,
        `A=${peerA.slice(0, 12) || "(absent)"} B=${peerB.slice(0, 12) || "(absent)"} (first published tip ${peerTip.slice(0, 12)})`);

      await teardownAccount(ctx, rec);
    } catch (e) {
      ctx.log(`✗ scenario aborted: ${errMsg(e)}`);
    } finally {
      // The full sync firehose lands in run.log only (console stays compact).
      ctx.transcript(`── worktree-squash-lifecycle sync outputs ──\n${sink.join("\n")}`);
      // Stop daemons before account teardown (a live daemon mid-op races the DELETE).
      await ctx.a.daemonStop(GUEST.workDir).catch(() => {});
      await ctx.b.daemonStop(GUEST.workDir).catch(() => {});
    }

    return finalizeReport({
      scenario: worktreeSquashLifecycle.name,
      startedAt,
      finishedAt: new Date().toISOString(),
      steps: rec.steps,
      assertions: rec.assertions,
    });
  },
};
