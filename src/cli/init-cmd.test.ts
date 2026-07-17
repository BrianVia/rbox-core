import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  continueInitWithPrecreatedWorkspace,
  GITIGNORE_CHOICES,
  GUIDED_GENESIS_PULL_NOTICE,
  guidedGenesisPullNotice,
  promptMissing,
  adoptPrecreatedWorkspaceResources,
  writeGuidedGenesisPullNotice,
} from "./init-cmd.js";
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
