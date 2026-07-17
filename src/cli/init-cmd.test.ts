import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  continueInitWithPrecreatedWorkspace,
  GITIGNORE_CHOICES,
  GUIDED_GENESIS_PULL_NOTICE,
  guidedGenesisPullNotice,
  initRebindNeedsReset,
  promptMissing,
  adoptPrecreatedWorkspaceResources,
  preflightInitRebind,
  writeGuidedGenesisPullNotice,
} from "./init-cmd.js";
import { saveConfig } from "./config.js";
import type { InitPlan } from "./init-plan.js";
import { mintSetupCreateConsent, mintSetupExistingConsent } from "./reset-consent.js";
import { promptPath } from "./prompt.js";

test("interactive init gitignore prompt defaults to skipping and matches setup's honest choices", () => {
  expect(GITIGNORE_CHOICES).toEqual([
    {
      name: "Skip gitignored untracked files (recommended)",
      value: "true",
      description: "re-include specific files with ! lines in .rboxignore (e.g. !.env), or switch later with `rbox ignore --respect-gitignore off`",
    },
    {
      name: "Sync gitignored files too (end-to-end encrypted)",
      value: "false",
      description: "rbox can never read them; great for notes/local state (and .env via !.env), but large builds/datasets sync too",
    },
  ]);
});

async function rebindFixture(): Promise<{ root: string; oldStream: string; nonce: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-init-consent-"));
  await saveConfig(root, {
    schema: "e2ee/v1",
    remoteUrl: "https://old.test",
    remoteWorkspaceId: "ws_old",
    projectId: "root",
    rootPath: root,
    deviceId: "dev_old",
    token: "",
  });
  const nonce = "0123456789abcdef0123456789abcdef";
  const oldStream = "https://old.test::ws_old::root";
  await fs.writeFile(path.join(root, ".rbox", "state.json"), JSON.stringify({
    stream: oldStream,
    stateNonce: nonce,
    stateRevision: 4,
    lastSyncedSequence: 3,
    lastSyncedManifest: { generatedAt: "old", files: [] },
  }));
  return { root, oldStream, nonce };
}

function plan(root: string, workspace: InitPlan["workspace"]): InitPlan {
  return {
    root,
    remoteUrl: "https://new.test",
    workspace,
    auth: "have",
    firstSync: "none",
    syncGit: true,
    respectGitignore: false,
  };
}

test("direct init refuses a differing existing binding; setup witness passes preflight", async () => {
  const fixture = await rebindFixture();
  try {
    const next = plan(fixture.root, { kind: "join", id: "ws_new", project: "root" });
    await expect(preflightInitRebind(next)).rejects.toThrow(/without setup confirmation/);
    const consent = mintSetupExistingConsent({
      root: fixture.root,
      observedOldStream: fixture.oldStream,
      observedOldNonce: fixture.nonce,
      mintedAtRevision: 4,
      remoteUrl: "https://new.test",
      workspaceId: "ws_new",
      projectId: "root",
    });
    await expect(preflightInitRebind(next, consent)).resolves.toBeUndefined();
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("create-new init requires Stage-A consent before any workspace id exists", async () => {
  const fixture = await rebindFixture();
  try {
    const next = plan(fixture.root, { kind: "new", project: "root", name: "display metadata" });
    await expect(preflightInitRebind(next)).rejects.toThrow(/without setup confirmation/);
    const consent = mintSetupCreateConsent({
      root: fixture.root,
      observedOldStream: fixture.oldStream,
      observedOldNonce: fixture.nonce,
      mintedAtRevision: 4,
      remoteUrl: "https://new.test",
      projectId: "root",
    });
    await expect(preflightInitRebind(next, consent)).resolves.toBeUndefined();
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("init reset decision covers marker/state-only lineage and config-already-next disagreement", () => {
  const oldStream = "https://api.test::ws_old::root";
  const nextStream = "https://api.test::ws_new::root";
  expect(initRebindNeedsReset(undefined, oldStream, nextStream)).toBe(true);
  expect(initRebindNeedsReset(nextStream, oldStream, nextStream)).toBe(true);
  expect(initRebindNeedsReset(oldStream, nextStream, nextStream)).toBe(false);
  expect(initRebindNeedsReset(oldStream, undefined, nextStream)).toBe(true);
  expect(initRebindNeedsReset(undefined, undefined, nextStream)).toBe(false);
});

test("direct init refuses a foreign incarnation marker even when config and state are absent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-init-marker-consent-"));
  try {
    await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
    await fs.writeFile(path.join(root, ".rbox", "state", "state-incarnation.json"), JSON.stringify({
      stream: "https://old.test::ws_old::root",
      stateNonce: "0123456789abcdef0123456789abcdef",
      stateRevision: 4,
    }));
    await expect(preflightInitRebind(plan(root, { kind: "join", id: "ws_new", project: "root" })))
      .rejects.toThrow(/without setup confirmation/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("interactive init path site uses promptPath with injected cwd and local tilde retry", async () => {
  const answers = ["~person/project", "relative/project"];
  const errors: string[] = [];
  const gathered = await promptMissing(
    { new: "true", project: "root", name: "-", "respect-gitignore": "true" },
    "/injected/cwd",
    {
      creds: undefined,
      defaultRemote: "https://api.test",
      promptPath: (opts) => promptPath({
        ...opts,
        input: (async () => answers.shift()!) as never,
        writeStderr: (text) => void errors.push(text),
      }),
    }
  );
  expect(gathered.root).toBe("/injected/cwd/relative/project");
  expect(errors).toEqual(["~user paths aren't supported — use an absolute path\n"]);
});

const continuationFlags = (root: string) => ({
  new: "true",
  root,
  project: "root",
  "no-interactive": "true",
});
const continuationCreds = async () => ({
  token: "tok",
  deviceId: "dev",
  accountId: "acct",
  remoteUrl: "https://api.test",
});

test("precreated continuation preserves new kind/id/held root and releases exactly once on success", async () => {
  const root = "/continued";
  let releases = 0;
  let executes = 0;
  const outcome = await continueInitWithPrecreatedWorkspace(
    continuationFlags(root),
    { cwd: "/elsewhere", defaultRemote: "https://api.test" },
    { workspaceId: "ws_precreated", syncMutex: { root } },
    {
      loadCredentials: continuationCreds,
      releaseMutex: async () => { releases++; },
      executePlan: (async (plan, _bootstrap, _opts, continuation) => {
        executes++;
        expect(plan.workspace.kind).toBe("new");
        expect(continuation?.workspaceId).toBe("ws_precreated");
        expect(continuation?.syncMutex.root).toBe(root);
        return { workspaceId: "ws_precreated", deviceId: "dev", root };
      }) as never,
    }
  );
  expect(outcome?.workspaceId).toBe("ws_precreated");
  expect(executes).toBe(1);
  expect(releases).toBe(1);
});

test("precreated continuation adopts the held mutex without ownership and rejects non-new plans", () => {
  const root = "/continued";
  const handle = { root };
  const resources = adoptPrecreatedWorkspaceResources(
    { root, remoteUrl: "https://api.test", workspace: { kind: "new", project: "root" } } as never,
    { workspaceId: "ws_precreated", syncMutex: handle }
  );
  expect(resources).toEqual({ workspaceId: "ws_precreated", syncMutex: handle, ownsSyncMutex: false });
  expect(() => adoptPrecreatedWorkspaceResources(
    { root, remoteUrl: "https://api.test", workspace: { kind: "existing", id: "ws_x", project: "root" } } as never,
    { workspaceId: "ws_precreated", syncMutex: handle }
  )).toThrow("requires a new-workspace plan");
  expect(() => adoptPrecreatedWorkspaceResources(
    { root: "/other", remoteUrl: "https://api.test", workspace: { kind: "new", project: "root" } } as never,
    { workspaceId: "ws_precreated", syncMutex: handle }
  )).toThrow();
});

test("precreated continuation releases exactly once on post-handoff failure and root assertion failure", async () => {
  const root = "/continued";
  for (const scenario of ["execute", "root"] as const) {
    let releases = 0;
    let executes = 0;
    await expect(continueInitWithPrecreatedWorkspace(
      continuationFlags(root),
      { cwd: "/elsewhere", defaultRemote: "https://api.test" },
      { workspaceId: "ws_precreated", syncMutex: { root: scenario === "root" ? "/wrong" : root } },
      {
        loadCredentials: continuationCreds,
        releaseMutex: async () => { releases++; },
        executePlan: (async () => { executes++; throw new Error("post-handoff failure"); }) as never,
      }
    )).rejects.toThrow(scenario === "root" ? "different root" : "post-handoff failure");
    expect(releases).toBe(1);
    expect(executes).toBe(scenario === "root" ? 0 : 1);
  }
});

test("guided genesis pull notice uses initial sequence only and scripted init stays silent", () => {
  expect(guidedGenesisPullNotice(true, 0)).toBe(GUIDED_GENESIS_PULL_NOTICE);
  expect(guidedGenesisPullNotice(true, 1)).toBeUndefined();
  expect(guidedGenesisPullNotice(false, 0)).toBeUndefined();
  const guided: string[] = [];
  writeGuidedGenesisPullNotice(true, 0, (text) => void guided.push(text));
  expect(guided.join("")).toContain(GUIDED_GENESIS_PULL_NOTICE);
  const scripted: string[] = [];
  writeGuidedGenesisPullNotice(false, 0, (text) => void scripted.push(text));
  expect(scripted).toEqual([]);
});

test("join branch passes the same sync result's initial sequence to guided output", async () => {
  const source = await fs.readFile(path.join(import.meta.dir, "init-cmd.ts"), "utf8");
  expect(source).toContain("const { pulled, pushedSequence, initialRemoteSequence } = await sync(plan.root, authed, deps)");
  expect(source).toContain("writeGuidedGenesisPullNotice(opts.guidedSetup, initialRemoteSequence)");
  expect(source).not.toContain("writeGuidedGenesisPullNotice(opts.guidedSetup, pushedSequence)");
});
