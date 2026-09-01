import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FileEntry, IgnoreMatcher, Manifest } from "../engine/index.js";
import { listIgnoreRules, purgeSummaryLines, setRespectGitignore } from "./ignore-cmd.js";
import { folderCatalogPath } from "./rbox-paths.js";
import { ensureFolderAuthority } from "./folder-authority.js";
import { serializeFolderCatalog, setFolderOptions } from "./folder-config.js";
import { assertNoUnevaluatedPurgeDeletes, MassDeleteGuardError } from "./sync/policy.js";
import { preparePublishCandidate, type GitCapturePort, type PublishPolicy } from "./sync/publish-candidate.js";

const originalLog = console.log;
afterEach(() => { console.log = originalLog; });

test("bare ignore collapses builtins while --list prints every rule", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-ignore-list-"));
  const rboxHome = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-ignore-home-"));
  const priorRboxHome = process.env.RBOX_HOME;
  process.env.RBOX_HOME = rboxHome;
  await fs.mkdir(path.join(root, ".rbox"));
  await fs.writeFile(path.join(root, ".rbox", "workspace.json"), JSON.stringify({
    remoteWorkspaceId: "ws_ignore",
    deviceId: "dev_ignore",
    respectGitignore: true,
  }));
  await fs.mkdir(path.dirname(folderCatalogPath()), { recursive: true });
  await fs.writeFile(folderCatalogPath(), serializeFolderCatalog({
    schemaVersion: 1,
    globalOptions: {},
    folders: [{ name: "Ignore test", path: root, options: { respectGitignore: false } }],
  }));
  await fs.writeFile(path.join(root, ".gitignore"), "generated/**\n");
  await fs.writeFile(path.join(root, ".rboxignore"), "dist/**\n");
  const logs: string[] = [];
  const bindingBefore = await fs.readFile(path.join(root, ".rbox", "workspace.json"), "utf8");
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  try {
    await listIgnoreRules(root);
    const summary = logs.join("\n");
    expect(summary).toContain("respectGitignore: off");
    expect(summary).toContain("[.gitignore present but NOT applied (respectGitignore off)] generated/**");
    expect(summary).toContain("default patterns (node_modules, .git, build caches, …)");
    expect(summary).toContain("[.rboxignore] dist/**");
    expect(summary).not.toContain("[builtin] node_modules");
    logs.length = 0;
    await setFolderOptions(root, { respectGitignore: true });
    expect(await fs.readFile(path.join(root, ".rbox", "workspace.json"), "utf8")).toBe(bindingBefore);
    await listIgnoreRules(root, { full: true });
    expect(logs.join("\n")).toContain("respectGitignore: on");
    expect(logs.join("\n")).toContain("[.gitignore ACTIVE] generated/**");
    expect(logs.join("\n")).toContain("[builtin] node_modules");
  } finally {
    if (priorRboxHome === undefined) delete process.env.RBOX_HOME;
    else process.env.RBOX_HOME = priorRboxHome;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(rboxHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Design 224 §2.4 — purge corrections. `rbox ignore --purge` was the outlier on
// all three: it named the wrong recovery command, ignored the env-var consent its
// own error text advertises, and carried a second copy of the unevaluated-repo
// refusal that could drift from the enforcing one.
// ---------------------------------------------------------------------------

const PURGE_HINT = "rbox ignore --purge --allow-mass-delete";
const SYNC_HINT = "rbox sync --allow-mass-delete";

const entry = (p: string): FileEntry => ({ path: p, sha256: "a".repeat(64), size: 1, mode: 0o644, mtimeMs: 0, type: "file" });
const manifest = (files: FileEntry[]): Manifest => ({ generatedAt: "2026-07-29T00:00:00.000Z", files });

function stubCapture(): GitCapturePort {
  // Annotated, not asserted: the return type contextually types every method, so a
  // drifted port signature fails here instead of being cast away.
  return {
    async execute(plan) {
      return {
        planId: plan.planId,
        plan: {
          changed: false, authoredCfgHashByRepo: {}, captured: [], carried: [], supersededPending: [],
          protectedPending: [], deferred: [], captureDeferrals: {}, configDeferrals: {}, captureObserved: [],
          configObserved: [], skipped: [], removed: [],
        },
      };
    },
    notifyBusyDeferred() {},
    async observe() {
      return { kind: "no-change", acceptedSequence: 0, observedRepos: [], deferralUpdates: {} };
    },
    reportCapturePlan() {},
    async carryBaseOnNoOp() {},
    logPublicationLine() {},
  };
}

const PASSTHROUGH: IgnoreMatcher = { ignores: () => false };

function purgeCandidate(
  appliedBase: Manifest,
  local: Manifest,
  matcher: IgnoreMatcher,
  policy: Partial<PublishPolicy> = {},
): Promise<unknown> {
  return preparePublishCandidate(
    { acceptedSequence: 0, appliedBase },
    {
      manifest: local,
      matcher,
      projected: true,
      caseCollisions: [],
      authority: "authoritative",
      async recordProjection() {},
    },
    stubCapture(),
    {
      purgeIgnored: true, repairing: false, syncGit: false, filesFirstEnabled: false,
      filesFirstAborted: false, streamMismatch: false, forceGitRecapture: new Set<string>(),
      allowMassDelete: false, now: () => new Date("2026-07-29T00:00:00.000Z"),
      ...policy,
    },
  );
}

/** 1999 of 2000 deleted: over both legs of the push-side mass-delete breaker. */
const massDeletePurge = (policy: Partial<PublishPolicy> = {}): Promise<unknown> => purgeCandidate(
  manifest(Array.from({ length: 2000 }, (_unused, i) => entry(`f${i}.txt`))),
  manifest([entry("f0.txt")]),
  PASSTHROUGH,
  policy,
);

const caught = async (p: Promise<unknown>): Promise<Error | undefined> => {
  try {
    await p;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
};

test("the purge-path mass-delete guard names the purge command, not `rbox push`", async () => {
  const err = await caught(massDeletePurge({ massDeleteHint: PURGE_HINT }));
  expect(err).toBeInstanceOf(MassDeleteGuardError);
  expect(err!.message).toContain(PURGE_HINT);
  expect(err!.message).not.toContain("rbox push");
  // The env var the message advertises must actually be honored by the purge path.
  expect(err!.message).toContain("RBOX_ALLOW_MASS_DELETE=1");
});

test("without a hint the guard still falls back to the push wording (unchanged for other flows)", async () => {
  const err = await caught(massDeletePurge());
  expect(err).toBeInstanceOf(MassDeleteGuardError);
  expect(err!.message).toContain("rbox push --allow-mass-delete");
});

test("purge honors explicit and RBOX_ALLOW_MASS_DELETE consent", async () => {
  expect(await fixtureJson("./ignore-consent.fixture.js")).toEqual([
    { allow: false, hint: PURGE_HINT },
    { allow: true, hint: PURGE_HINT },
    { allow: true, hint: PURGE_HINT },
  ]);
});

async function fixtureJson(name: string): Promise<unknown> {
  const child = Bun.spawn([
    process.execPath,
    new URL(name, import.meta.url).pathname,
  ], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit, stderr).toBe(0);
  return JSON.parse(stdout);
}

test("push and sync map explicit and RBOX_ALLOW_MASS_DELETE consent into LocalRuntime operations", async () => {
  expect(await fixtureJson("./sync-consent.fixture.js")).toEqual([
    { operation: { kind: "push", massDelete: "guarded" } },
    { operation: { kind: "push", massDelete: "allow" } },
    { operation: { kind: "push", massDelete: "allow" } },
    { operation: { kind: "sync", mode: "pull-push", massDelete: "guard-both" }, hint: SYNC_HINT },
    { operation: { kind: "sync", mode: "pull-push", massDelete: "allow-push" }, hint: SYNC_HINT },
    { operation: { kind: "sync", mode: "pull-push", massDelete: "allow-both" }, hint: SYNC_HINT },
  ]);
});

test("recover maps env consent to push only and explicit consent to both directions", async () => {
  expect(await fixtureJson("./recover-consent.fixture.js")).toEqual([
    { allow: false, allowPush: false },
    { allow: false, allowPush: true },
    { allow: true, allowPush: true },
  ]);
});

test("consent lets the same purge through, so the guard is the only thing refusing", async () => {
  expect(await caught(massDeletePurge({ allowMassDelete: true, massDeleteHint: PURGE_HINT }))).toBeUndefined();
});

test("the unevaluated-repo purge refusal has ONE source of truth: preview and publish emit the identical message", async () => {
  const blocked: IgnoreMatcher = {
    ignores: () => true,
    unevaluatedGitRepoForPath: (p) => (p.startsWith("hidden/") ? "hidden" : undefined),
  };
  let previewError: Error | undefined;
  try {
    assertNoUnevaluatedPurgeDeletes(blocked, ["keep.txt", "hidden/drop.txt"]);
  } catch (e) {
    previewError = e as Error;
  }
  expect(previewError?.message).toMatch(/^refusing purge: cannot evaluate tracked files for git repo hidden/);

  const publishError = await caught(purgeCandidate(
    manifest([entry("keep.txt"), entry("hidden/drop.txt")]),
    manifest([entry("keep.txt")]),
    blocked,
    { allowMassDelete: true },
  ));

  expect(publishError?.message).toBe(previewError?.message);
});

/**
 * The loss class design 276 F1.3 has to close.
 *
 * `rbox ignore --respect-gitignore` used to write the CATALOG only, so the
 * binding kept its original value forever. Once an absent catalog is
 * reinitialized from the bindings, that stale binding silently reverts the
 * user's setting — the "nothing to lose by construction" claim only holds if
 * every catalog-only policy editor keeps its binding a complete snapshot.
 */
test("a respect-gitignore edit survives losing and reinitializing the folder catalog", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-ignore-roundtrip-"));
  const rboxHome = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-ignore-roundtrip-home-"));
  const priorRboxHome = process.env.RBOX_HOME;
  process.env.RBOX_HOME = rboxHome;
  await fs.mkdir(path.join(root, ".rbox"));
  await fs.writeFile(path.join(root, ".rbox", "workspace.json"), JSON.stringify({
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws_roundtrip",
    projectId: "root",
    deviceId: "dev_roundtrip",
    rootPath: root,
    remoteUrl: "https://api.test",
    token: "",
    respectGitignore: false,
  }));
  await fs.mkdir(path.dirname(folderCatalogPath()), { recursive: true });
  await fs.writeFile(folderCatalogPath(), serializeFolderCatalog({
    schemaVersion: 1,
    globalOptions: {},
    folders: [{ name: "Roundtrip", path: root, options: { respectGitignore: false } }],
  }));
  console.log = () => {};
  try {
    await setRespectGitignore(root, "on");
    await fs.rm(folderCatalogPath());
    const healed = await ensureFolderAuthority({ currentRoot: root });
    expect(healed.snapshot.folders[0]?.policy.respectGitignore).toBe(true);
  } finally {
    if (priorRboxHome === undefined) delete process.env.RBOX_HOME;
    else process.env.RBOX_HOME = priorRboxHome;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(rboxHome, { recursive: true, force: true });
  }
});

// #838: "5 paths would be deleted ... top-level: Personal, chromium" was the whole
// consent surface for a purge that should have removed 187,000 entries. The line has
// to size what leaves, per top-level name, before anyone types y.
test("the purge dry-run sizes the deletion per top-level name", async () => {
  const purged = [
    ...Array.from({ length: 1200 }, (_unused, i) => `chromium/src/f${i}.cc`),
    "Personal/a.txt",
    "Personal/b.txt",
    "loose.txt",
  ];
  expect(purgeSummaryLines(purged)).toEqual([
    "purge dry-run: 1,203 entries would be deleted from other machines.",
    "top-level: chromium (1,200), Personal (2), loose.txt (1)",
  ]);
  expect(purgeSummaryLines(["only.txt"])[0]).toBe("purge dry-run: 1 entry would be deleted from other machines.");
  const wide = Array.from({ length: 15 }, (_unused, i) => `d${i}/f.txt`);
  expect(purgeSummaryLines(wide)[1]).toEndWith(", and 3 more");
});

test("respect-gitignore takes only on|off — a bare flag (literal \"true\") is a usage error", async () => {
  // A valueless `--respect-gitignore` parses to "true"; accepting it silently turned
  // gitignore filtering ON with no value ever typed (#518).
  for (const raw of ["true", "false", "", undefined]) {
    await expect(setRespectGitignore("/nonexistent", raw)).rejects.toThrow("usage: rbox ignore --respect-gitignore <on|off>");
  }
});
