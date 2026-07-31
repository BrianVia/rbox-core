/**
 * `git-stale-opstate` — the field regression a paying customer sat behind for
 * seven days: `rbox git resolve <repo> keep-mine` refused with
 * `local-operation` ("a Git operation is in progress; finish or abort it, then
 * run keep-mine again") on a repo whose ONLY op-state was a stale
 * `.git/MERGE_MSG` left by a merge that had already CONCLUDED. Git itself
 * reported a clean tree and no operation in progress, so the refusal named a
 * state the user could neither finish nor abort — unactionable by construction.
 *
 * The fix reclassifies MERGE_MSG and AUTO_MERGE as `breadcrumb` in
 * OP_STATE_CLASSIFICATION so `hasInProgressOpState` matches git's own
 * `wt_status_get_state` definition (MERGE_HEAD / CHERRY_PICK_HEAD /
 * REVERT_HEAD / rebase-merge / rebase-apply / sequencer). REBASE_HEAD stays
 * in-progress.
 *
 * The scenario proves BOTH directions on one wedge:
 *
 *   POSITIVE — with the stale fossil present (and no MERGE_HEAD), keep-mine
 *   must not emit the local-operation refusal; it must reach the ordinary
 *   preview → confirm → publish flow and both devices must converge.
 *
 *   NEGATIVE CONTROL — with a REAL conflicted merge outstanding (MERGE_HEAD
 *   present, uncommitted), keep-mine MUST still refuse with exactly that
 *   message. `git merge --abort` then restores the working flow.
 *
 * Fossil provenance: the rig runs a real conflicting merge and CONCLUDES it,
 * capturing git's own MERGE_MSG (and AUTO_MERGE) bytes mid-merge. On git 2.54.0
 * every concluded or abandoned flow (commit, --no-edit commit, --abort, --quit,
 * reset --hard, --squash + commit) removes MERGE_MSG, so no modern flow reliably
 * strands it — the field fossil came from an older git or an interrupted tool.
 * The rig therefore replants the captured bytes after the merge concludes: the
 * fossils are git's own content and the merge really did conclude, which is
 * exactly the customer's on-disk shape.
 *
 * The rig image installs UNPINNED git, and the fixture asserts that the
 * concluded merge cleaned both files up. If a future git version RETAINS them,
 * that assertion fails first and the SETUP step is what needs adjusting — the
 * product behavior under test is unaffected either way.
 *
 * MANUAL / explicit-only: NOT in FAST_SUITE — it is the pre-merge guard for the
 * op-state reclassification, run by name like its `git-*` siblings.
 */
import { GUEST } from "../lib/config.js";
import type { Device } from "../lib/device.js";
import { createRecorder, errMsg } from "./harness.js";
import type { Recorder } from "./harness.js";
import { CONCURRENCY, provisionPair, teardownAccount } from "./preamble.js";
import type { RigCtx, Scenario, ScenarioReport } from "./types.js";
import { finalizeReport } from "./types.js";

const REPO = "repo-stale-opstate";
const repoPath = `${GUEST.workDir}/${REPO}`;
const gitDir = `${repoPath}/.git`;
/** Guest-local holding pens for git's own op-state bytes, captured mid-merge. */
const FOSSIL = "/tmp/rig-stale-merge-msg";
const FOSSIL_AUTO = "/tmp/rig-stale-auto-merge";
const IDENT = `-c user.name='Rig Tester' -c user.email='rig@example.com'`;
/** The exact refusal the field hit — the one string this scenario exists for. */
const OPERATION_REFUSAL = "a Git operation is in progress";

/** Fixed identity + a per-commit date pin so the SAME logical commit run on A
 *  and B mints the SAME sha (the divergence seed relies on it, as in
 *  git-held-livelock). */
const detScript = (body: string): string => `
set -e
export GIT_AUTHOR_NAME='Rig Tester' GIT_AUTHOR_EMAIL='rig@example.com'
export GIT_COMMITTER_NAME='Rig Tester' GIT_COMMITTER_EMAIL='rig@example.com'
D() { export GIT_AUTHOR_DATE="$1T00:00:00 +0000" GIT_COMMITTER_DATE="$1T00:00:00 +0000"; }
${body}`.replace(/git /g, `git ${IDENT} `);

/**
 * Seed the repo on A: two branches that each conflict with `main`, then a REAL
 * conflicted merge of the first one that is resolved and committed. `fossil-source`
 * supplies the concluded merge (and its captured MERGE_MSG); `neg-source` is held
 * back for the negative control's genuinely-in-progress merge.
 */
const BUILD_REPO = `
mkdir -p '${repoPath}'
cd '${repoPath}'
git init -q -b main
printf 'base\\n' > shared.txt
printf 'base\\n' > neg.txt
D 2026-02-01; git add -A && git commit -q -m 'base'
git checkout -q -b fossil-source
printf 'fossil-side\\n' > shared.txt
D 2026-02-02; git add -A && git commit -q -m 'fossil branch edit'
git checkout -q -b neg-source main
printf 'neg-side\\n' > neg.txt
D 2026-02-03; git add -A && git commit -q -m 'negative-control branch edit'
git checkout -q main
printf 'main-side\\n' > shared.txt
printf 'main-side\\n' > neg.txt
D 2026-02-04; git add -A && git commit -q -m 'main edit'
git merge fossil-source >/dev/null 2>&1 || true
test -f '${gitDir}/MERGE_MSG'
cp '${gitDir}/MERGE_MSG' '${FOSSIL}'
# AUTO_MERGE is ort's conflicted-worktree scratch TREE (git >= 2.38). Capture the
# real one when this git wrote it; otherwise plant a valid tree oid so the fossil
# still names an object that exists in the repo.
if [ -f '${gitDir}/AUTO_MERGE' ]; then cp '${gitDir}/AUTO_MERGE' '${FOSSIL_AUTO}'; fi
printf 'merged\\n' > shared.txt
git add shared.txt
D 2026-02-05; git commit -q --no-edit
if [ ! -f '${FOSSIL_AUTO}' ]; then git rev-parse 'HEAD^{tree}' > '${FOSSIL_AUTO}'; fi
`;

/** The deterministic X→X2 advance — run VERBATIM on both devices so the sha
 *  matches and A's history strictly subsumes the section B publishes. */
const ADVANCE_X2 = `
cd '${repoPath}'
printf 'x2\\n' > x2.txt
D 2026-03-01; git add x2.txt && git commit -q -m 'shared advance'
`;

/** A's local-ahead commit — A only, after X2. */
const ADVANCE_Y = `
cd '${repoPath}'
printf 'y\\n' > y.txt
D 2026-03-02; git add y.txt && git commit -q -m 'A local ahead'
`;

interface RepoRecordView {
  pending?: unknown;
  deferrals?: Record<string, { lane?: string; reason?: string }>;
}

interface SyncStateView {
  repoRecords?: Record<string, RepoRecordView>;
}

interface ResolveJson {
  status?: string;
  code?: string;
  message?: string;
  confirm?: { snapshot?: string; forceDiscardIncoming?: boolean };
  sequence?: number;
}

async function readRecord(device: Device): Promise<RepoRecordView | undefined> {
  const raw = JSON.parse(await device.readFile(`${GUEST.workDir}/.rbox/state.json`)) as SyncStateView & { syncState?: SyncStateView };
  return (raw.repoRecords ? raw : raw.syncState ?? raw).repoRecords?.[REPO];
}

async function git(device: Device, args: string[], allowFail = false) {
  return device.exec(["git", "-C", repoPath, ...args], { allowFail });
}

async function head(device: Device): Promise<string> {
  const r = await git(device, ["rev-parse", "HEAD"], true);
  return r.exitCode === 0 ? r.stdout.trim() : "";
}

async function porcelain(device: Device): Promise<string> {
  return (await git(device, ["status", "--porcelain=v1"], true)).stdout;
}

async function present(device: Device, path: string): Promise<boolean> {
  return (await device.exec(["test", "-e", path], { allowFail: true })).exitCode === 0;
}

/** Run `rbox git resolve <repo> keep-mine …` and return the emitted JSON plus the
 *  raw streams. `--json` prints exactly one object; RBOX_METRICS can add lines
 *  around it, so the LAST `{`-leading line is the verdict. */
async function keepMine(device: Device, extra: string[] = []): Promise<{ json: ResolveJson; raw: string }> {
  const run = await device.rbox(["git", "resolve", REPO, "keep-mine", "--json", ...extra], { cwd: GUEST.workDir, allowFail: true });
  const raw = `${run.stdout}\n${run.stderr}`;
  const line = run.stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).at(-1);
  let json: ResolveJson = {};
  if (line) {
    try { json = JSON.parse(line) as ResolveJson; } catch { json = {}; }
  }
  return { json, raw };
}

/** Restore git's own captured MERGE_MSG + AUTO_MERGE bytes as the stale fossils —
 *  the exact pair this fix reclassifies. */
async function plantFossil(device: Device): Promise<void> {
  await device.exec(["cp", FOSSIL, `${gitDir}/MERGE_MSG`]);
  await device.exec(["cp", FOSSIL_AUTO, `${gitDir}/AUTO_MERGE`]);
}

/** The fossils' defining shape: MERGE_MSG + AUTO_MERGE present, MERGE_HEAD absent,
 *  tree clean — i.e. git believes nothing is in progress. */
async function assertFossilShape(rec: Recorder, device: Device, label: string): Promise<void> {
  const [msg, auto, mergeHead, status] = await Promise.all([
    present(device, `${gitDir}/MERGE_MSG`),
    present(device, `${gitDir}/AUTO_MERGE`),
    present(device, `${gitDir}/MERGE_HEAD`),
    porcelain(device),
  ]);
  rec.assert(`${label}: stale MERGE_MSG + AUTO_MERGE present, no MERGE_HEAD, tree clean`,
    msg && auto && !mergeHead && status.trim() === "",
    `MERGE_MSG=${msg} AUTO_MERGE=${auto} MERGE_HEAD=${mergeHead} status=${JSON.stringify(status)}`);
}

export const gitStaleOpstate: Scenario = {
  name: "git-stale-opstate",
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    const rec: Recorder = createRecorder(ctx);
    const startedAt = new Date().toISOString();

    try {
      // ── Fixture: a REAL conflicted merge that concludes ────────────────────
      await rec.step("[A] seed repo + conclude a real conflicted merge", async () => {
        await ctx.a.exec(["sh", "-c", detScript(BUILD_REPO)]);
      });
      const [fossilBytes, autoBytes, msgAfterConclude, autoAfterConclude, mergeHeadAfterConclude, statusAfterConclude] = await Promise.all([
        ctx.a.readFile(FOSSIL),
        ctx.a.readFile(FOSSIL_AUTO),
        present(ctx.a, `${gitDir}/MERGE_MSG`),
        present(ctx.a, `${gitDir}/AUTO_MERGE`),
        present(ctx.a, `${gitDir}/MERGE_HEAD`),
        porcelain(ctx.a),
      ]);
      rec.assert("fixture: git wrote a real MERGE_MSG during the merge", fossilBytes.trim() !== "",
        JSON.stringify(fossilBytes.split("\n")[0] ?? ""));
      rec.assert("fixture: an AUTO_MERGE tree oid is available to replant", /^[0-9a-f]{40}$/.test(autoBytes.trim()),
        JSON.stringify(autoBytes.trim()));
      // The rig image installs UNPINNED git. This step asserts what current git does
      // (2.54 removes both on conclude); if a future git RETAINS them, it is this
      // setup step that needs adjusting, not the product under test.
      rec.assert("fixture: the concluded merge left no op-state behind",
        !msgAfterConclude && !autoAfterConclude && !mergeHeadAfterConclude && statusAfterConclude.trim() === "",
        `MERGE_MSG=${msgAfterConclude} AUTO_MERGE=${autoAfterConclude} MERGE_HEAD=${mergeHeadAfterConclude} status=${JSON.stringify(statusAfterConclude)} (git 2.54 cleans them; the field fossil predates that, so the rig replants these exact bytes)`);

      await provisionPair(ctx, rec);
      const headX = await head(ctx.a);
      rec.assert("baseline: B materialized A's merged history", (await head(ctx.b)) === headX,
        `A=${headX.slice(0, 12)} B=${(await head(ctx.b)).slice(0, 12)}`);

      // ── Divergence: both sides changed, A's history subsumes the section B
      //    publishes (the shape keep-mine exists to resolve). ────────────────
      await rec.step("[B] advances X→X2 and publishes", async () => {
        await ctx.b.exec(["sh", "-c", detScript(ADVANCE_X2)]);
        await ctx.b.rbox(["push"], { cwd: GUEST.workDir, env: { RBOX_UPLOAD_CONCURRENCY: CONCURRENCY } });
      });
      let headY = "";
      await rec.step("[A] mints the identical X2, then commits Y ahead", async () => {
        await ctx.a.exec(["sh", "-c", detScript(ADVANCE_X2)]);
        const [x2a, x2b] = [await head(ctx.a), await head(ctx.b)];
        if (!x2a || x2a !== x2b) throw new Error(`deterministic X2 shas diverged (A=${x2a.slice(0, 8)} B=${x2b.slice(0, 8)}) — seed invalid`);
        await ctx.a.exec(["sh", "-c", detScript(ADVANCE_Y)]);
        headY = await head(ctx.a);
      });

      // Supersession OFF for the settle round: a default push heals the hold
      // (design 174) before the wedge is observable — the same fixture rule
      // git-held-livelock learned. The file plane must settle first so the
      // offline commits' plain bytes stop masking the git-plane hold.
      let deferralReason = "";
      await rec.step("[A] settles the file plane and parks the git-plane hold", async () => {
        const noSupersede = { RBOX_GIT_PENDING_SUPERSEDE: "0" };
        for (let attempt = 0; attempt < 4; attempt++) {
          await ctx.a.rbox(["push"], { cwd: GUEST.workDir, env: { ...noSupersede, RBOX_UPLOAD_CONCURRENCY: CONCURRENCY }, allowFail: true });
          await ctx.a.rbox(["pull", "--verbose"], { cwd: GUEST.workDir, env: { ...noSupersede, RBOX_DOWNLOAD_CONCURRENCY: CONCURRENCY }, allowFail: true });
          const record = await readRecord(ctx.a);
          if (record?.pending !== undefined) {
            deferralReason = Object.values(record.deferrals ?? {}).map((d) => `${d.lane}/${d.reason}`).join(",");
            return;
          }
        }
        throw new Error("A never parked a pending git section — the divergence seed did not take");
      });
      rec.assert("wedge: A holds a pending incoming section with local main untouched",
        (await head(ctx.a)) === headY, `A HEAD must remain Y (${headY.slice(0, 12)}); deferral=${deferralReason || "(none named)"}`);

      // ── The fossil ────────────────────────────────────────────────────────
      await rec.step("[A] plant the stale MERGE_MSG + AUTO_MERGE fossils", () => plantFossil(ctx.a));
      await assertFossilShape(rec, ctx.a, "fossil");
      const idleRecord = await rec.step("[A] one more sync round does not clear the hold on its own", async () => {
        await ctx.a.rbox(["pull"], { cwd: GUEST.workDir, env: { RBOX_DOWNLOAD_CONCURRENCY: CONCURRENCY }, allowFail: true });
        return readRecord(ctx.a);
      });
      // Pinned to the EXACT standing reason, not merely "some hold": the daemon has
      // no auto-resolve path for an index-divergent ahead writer (keep-mine stays
      // explicit), and a future regression must not swap in an unrelated hold —
      // least of all local-operation, the bug this scenario exists to catch.
      const idleReason = Object.values(idleRecord?.deferrals ?? {}).map((d) => `${d.lane}/${d.reason}`).join(",");
      rec.assert("wedge: still deferred on the same local-index hold before any resolve",
        idleRecord?.pending !== undefined && idleReason === deferralReason && idleReason.includes("local-index"),
        `idle=${idleReason || "(none)"} parked=${deferralReason || "(none)"}`);

      // ── POSITIVE: the fossil must not be read as an operation ─────────────
      const preview = await rec.step("[A] keep-mine with only the stale fossil present", () => keepMine(ctx.a));
      rec.assert("fossil: keep-mine does not refuse with local-operation",
        !(preview.json.status === "refused" && preview.json.code === "local-operation") && !preview.raw.includes(OPERATION_REFUSAL),
        `status=${preview.json.status} code=${preview.json.code ?? "-"} ${preview.raw.trim().slice(-400)}`);
      rec.assert("fossil: keep-mine reaches the ordinary confirmable preview",
        preview.json.status === "preview" && typeof preview.json.confirm?.snapshot === "string",
        `status=${preview.json.status} message=${preview.json.message ?? "-"}`);

      // ── NEGATIVE CONTROL: a genuinely in-progress merge must still refuse ──
      await rec.step("[A] start a real conflicted merge (MERGE_HEAD outstanding)", async () => {
        await ctx.a.exec(["sh", "-c", detScript(`cd '${repoPath}'\ngit merge neg-source >/dev/null 2>&1 || true`)]);
        if (!await present(ctx.a, `${gitDir}/MERGE_HEAD`)) throw new Error("neg-source merge did not conflict — negative control invalid");
      });
      const refused = await rec.step("[A] keep-mine during the real merge", () => keepMine(ctx.a));
      rec.assert("control: a real MERGE_HEAD still refuses with local-operation",
        refused.json.status === "refused" && refused.json.code === "local-operation" && (refused.json.message ?? "").includes(OPERATION_REFUSAL),
        `status=${refused.json.status} code=${refused.json.code ?? "-"} message=${refused.json.message ?? "-"}`);

      await rec.step("[A] git merge --abort, replant the fossil", async () => {
        await git(ctx.a, ["merge", "--abort"]);
        await plantFossil(ctx.a);
      });
      await assertFossilShape(rec, ctx.a, "post-abort");

      // ── Resolve for real and converge both devices ────────────────────────
      const confirmable = await rec.step("[A] keep-mine preview after the abort", () => keepMine(ctx.a));
      rec.assert("control: resolve works again once the real merge is aborted",
        confirmable.json.status === "preview" && !confirmable.raw.includes(OPERATION_REFUSAL),
        `status=${confirmable.json.status} code=${confirmable.json.code ?? "-"} ${confirmable.raw.trim().slice(-400)}`);
      const snapshot = confirmable.json.confirm?.snapshot;
      if (!snapshot) throw new Error("keep-mine preview carried no confirmation snapshot");
      const published = await rec.step("[A] keep-mine --confirm publishes", () => keepMine(ctx.a, [
        "--confirm", snapshot,
        ...(confirmable.json.confirm?.forceDiscardIncoming ? ["--force-discard-incoming"] : []),
      ]));
      rec.assert("resolve: keep-mine published this device's truth",
        published.json.status === "published" || published.json.status === "ack-uncertain",
        `status=${published.json.status} ${published.raw.trim().slice(-400)}`);

      await rec.step("[A→B] converge", async () => {
        await ctx.a.rbox(["push"], { cwd: GUEST.workDir, env: { RBOX_UPLOAD_CONCURRENCY: CONCURRENCY }, allowFail: true });
        for (let attempt = 0; attempt < 3; attempt++) {
          await ctx.b.rbox(["pull"], { cwd: GUEST.workDir, env: { RBOX_DOWNLOAD_CONCURRENCY: CONCURRENCY }, allowFail: true });
          if ((await head(ctx.b)) === headY) return;
        }
        throw new Error(`B never reached Y (${headY.slice(0, 12)}); B=${(await head(ctx.b)).slice(0, 12)}`);
      });
      rec.assert("converged: A and B agree on A's history", (await head(ctx.a)) === headY && (await head(ctx.b)) === headY,
        `Y=${headY.slice(0, 12)} A=${(await head(ctx.a)).slice(0, 12)} B=${(await head(ctx.b)).slice(0, 12)}`);
      rec.assert("converged: A's hold cleared", (await readRecord(ctx.a))?.pending === undefined,
        JSON.stringify(await readRecord(ctx.a)));
      const [cleanA, cleanB] = [await porcelain(ctx.a), await porcelain(ctx.b)];
      rec.assert("converged: both working trees clean", cleanA.trim() === "" && cleanB.trim() === "",
        `A=${JSON.stringify(cleanA)} B=${JSON.stringify(cleanB)}`);

      await teardownAccount(ctx, rec);
    } catch (e) {
      ctx.log(`✗ scenario aborted: ${errMsg(e)}`);
    }

    return finalizeReport({ scenario: gitStaleOpstate.name, startedAt, finishedAt: new Date().toISOString(), steps: rec.steps, assertions: rec.assertions });
  },
};
