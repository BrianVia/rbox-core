import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GITIGNORE_CHOICES, preflightInitRebind } from "./init-cmd.js";
import { saveConfig } from "./config.js";
import type { InitPlan } from "./init-plan.js";
import { mintSetupCreateConsent, mintSetupExistingConsent } from "./reset-consent.js";

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
