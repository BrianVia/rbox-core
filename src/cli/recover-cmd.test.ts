import { describe, expect, test } from "bun:test";
import { recoverWorkspaceCmd } from "./recover-cmd.js";
import type { WorkspaceConfig } from "./config.js";
import type { SyncDeps } from "./sync.js";
import type { HeadPin } from "./e2ee-keystore.js";
import { ManifestChainError } from "../engine/index.js";

const cfg: WorkspaceConfig = {
  schema: "e2ee/v1",
  remoteWorkspaceId: "ws_1",
  projectId: "root",
  deviceId: "dev_1",
  rootPath: "/tmp/ws",
  remoteUrl: "https://api.test",
  token: "",
  encrypted: true,
};

const validCredentials = async () => ({
  state: "valid" as const,
  source: "disk" as const,
  credentials: { v: 1 as const, token: "tok", deviceId: "dev_1", remoteUrl: "https://api.test", accountId: "acct_1" },
  legacy: false,
  extensions: {},
});

const pin = (seq: number, hash = `${seq}`.padStart(64, "0")): HeadPin => ({
  commitSeq: seq,
  commitHash: hash,
  rosterVersion: 1,
  rosterHash: "r".repeat(64),
  accountEpoch: 1,
  keyStateHash: "k".repeat(64),
});

describe("recover workspace command", () => {
  test("credential degradation fails closed before remote construction or mutation", async () => {
    let built = 0;
    await expect(recoverWorkspaceCmd("/tmp/ws", { yes: true }, {
      findRoot: async () => "/tmp/ws",
      loadConfig: async () => cfg,
      loadCredentials: async () => ({ state: "unsupported-version", path: "/test/credentials.json", version: 2 }),
      buildAuthedRemote: async () => { built++; throw new Error("must not build"); },
    })).rejects.toThrow(/unsupported-version/);
    expect(built).toBe(0);
  });

  test("chain failure retains the newly verified head and requires suffix consent", async () => {
    let currentPin: HeadPin | undefined = pin(4);
    let confirmations = 0;
    let repaired = 0;
    const broken = new ManifestChainError("corrupt delta", { head: { seq: 6, hash: "b".repeat(64) }, failingLink: "c".repeat(64) });
    await recoverWorkspaceCmd("/tmp/ws", { yes: true }, {
      findRoot: async () => "/tmp/ws",
      loadConfig: async () => cfg,
      loadCredentials: validCredentials,
      pinStore: () => ({
        load: async () => currentPin,
        save: async (next) => { currentPin = next; },
        clear: async () => { currentPin = undefined; },
      }),
      buildAuthedRemote: async () => ({ cfg, deps: {}, remote: {} as never }),
      beginReport: () => ({ logSummaryTo: () => {} } as never),
      pull: async () => { currentPin = pin(6, "b".repeat(64)); throw broken; },
      confirm: async () => { confirmations++; return true; },
      repair: async (_root, _cfg, _deps, _error, opts) => {
        repaired++;
        await opts.confirmSupersede([{ seq: 5, deviceId: "dev_peer", reason: "corrupt delta" }, { seq: 6, deviceId: "dev_1", reason: "corrupt delta" }]);
        return { kind: "repaired", sequence: 7, suffix: [], actions: [] };
      },
      log: () => {},
    });
    expect(repaired).toBe(1);
    expect(confirmations).toBe(0); // --yes authorizes the suffix ceremony
    expect(currentPin?.commitSeq).toBe(6);
  });

  test("--repair-chain bypasses only the chain suffix prompt", async () => {
    let currentPin: HeadPin | undefined = pin(2);
    const broken = new ManifestChainError("missing link", { head: { seq: 3, hash: "d".repeat(64) } });
    await recoverWorkspaceCmd("/tmp/ws", { repairChain: true }, {
      findRoot: async () => "/tmp/ws",
      loadConfig: async () => cfg,
      loadCredentials: validCredentials,
      pinStore: () => ({ load: async () => currentPin, save: async (next) => { currentPin = next; }, clear: async () => { currentPin = undefined; } }),
      buildAuthedRemote: async () => ({ cfg, deps: {}, remote: {} as never }),
      beginReport: () => ({ logSummaryTo: () => {} } as never),
      pull: async () => { currentPin = pin(3, "d".repeat(64)); throw broken; },
      confirm: async () => true,
      repair: async (_root, _cfg, _deps, _error, opts) => {
        expect(await opts.confirmSupersede([{ seq: 3, deviceId: "dev_1", reason: "missing link" }])).toBe(true);
        return { kind: "repaired", sequence: 4, suffix: [], actions: [] };
      },
      log: () => {},
    });
    expect(currentPin?.commitSeq).toBe(3);
  });

  test("normal recover pulls with the retained pin and never clears it", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const depsObj: SyncDeps = {};

    await recoverWorkspaceCmd("/tmp/ws", { yes: true }, {
      findRoot: async () => "/tmp/ws",
      loadConfig: async () => cfg,
      loadCredentials: validCredentials,
      pinStore: (accountId, workspaceId) => ({
        load: async () => undefined,
        save: async () => {},
        clear: async () => calls.push(`clear:${accountId}:${workspaceId}`),
      }),
      buildAuthedRemote: async () => ({ cfg, deps: depsObj, remote: {} as never }),
      beginReport: () => ({ logSummaryTo: () => {} } as never),
      summarize: () => calls.push("summarize"),
      postSyncNudge: async () => calls.push("nudge"),
      pull: async () => {
        calls.push("pull");
        return [{ kind: "write", entry: { path: "remote.txt", type: "file", sha256: "x", size: 1, mtimeMs: 0 } }];
      },
      push: async () => {
        calls.push("push");
        return { sequence: 12, committed: true };
      },
      log: (line) => logs.push(line),
    });

    expect(calls).toEqual(["pull", "summarize", "nudge", "push"]);
    expect(depsObj.allowMassDelete).toBe(false);
    expect(logs.join("\n")).toContain("head re-verified");
    expect(logs.join("\n")).toContain("1 pulled");
  });

  test("pruned state re-baselines with the old pin retained, then reconciles", async () => {
    const calls: string[] = [];
    let currentPin: HeadPin | undefined = pin(474, "a".repeat(64));

    await recoverWorkspaceCmd("/tmp/ws", { yes: true }, {
      findRoot: async () => "/tmp/ws",
      loadConfig: async () => cfg,
      loadCredentials: validCredentials,
      pinStore: () => ({
        load: async () => currentPin,
        save: async (next) => {
          currentPin = next;
          calls.push(`save:${next.commitSeq}`);
        },
        clear: async () => {
          currentPin = undefined;
          calls.push("clear");
        },
      }),
      buildAuthedRemote: async () => ({ cfg, deps: {}, remote: {
        rebaselinePinToRetainedHead: async () => {
          expect(currentPin).toEqual(pin(474, "a".repeat(64)));
          currentPin = pin(475, "b".repeat(64));
          calls.push("save:475");
          return { sequence: 475 };
        },
      } as never }),
      beginReport: () => ({ logSummaryTo: () => {} } as never),
      summarize: () => calls.push("summarize"),
      postSyncNudge: async () => calls.push("nudge"),
      pull: async () => {
        calls.push("pull");
        if (calls.filter((c) => c === "pull").length === 1) {
          const { NeedsRebaselineError } = await import("./remote.js");
          throw new NeedsRebaselineError(475);
        }
        return [{ kind: "write", entry: { path: "server.txt", type: "file", sha256: "srv", size: 6, mtimeMs: 0 } }];
      },
      push: async () => {
        calls.push("push");
        return { sequence: 475, committed: false };
      },
      log: () => {},
    });

    expect(calls).toEqual(["pull", "save:475", "pull", "summarize", "nudge", "push"]);
    expect(currentPin?.commitSeq).toBe(475);
  });

  test("equal-sequence different-hash re-baseline is refused with the prior pin continuously present", async () => {
    const prior = pin(475, "a".repeat(64));
    let currentPin: HeadPin | undefined = prior;
    let clears = 0;
    let pulls = 0;
    await expect(recoverWorkspaceCmd("/tmp/ws", { yes: true }, {
      findRoot: async () => "/tmp/ws",
      loadConfig: async () => cfg,
      loadCredentials: validCredentials,
      pinStore: () => ({
        load: async () => currentPin,
        save: async (next) => { currentPin = next; },
        clear: async () => { clears++; currentPin = undefined; },
      }),
      buildAuthedRemote: async () => ({ cfg, deps: {}, remote: {
        rebaselinePinToRetainedHead: async () => {
          expect(currentPin).toEqual(prior);
          throw new Error("recover refused: replacement head differs at the pinned sequence (fork/equivocation)");
        },
      } as never }),
      pull: async () => {
        pulls++;
        const { NeedsRebaselineError } = await import("./remote.js");
        throw new NeedsRebaselineError(475);
      },
    })).rejects.toThrow(/fork\/equivocation/);
    expect(currentPin).toEqual(prior);
    expect(clears).toBe(0);
    expect(pulls).toBe(1);
  });

  test("true rollback refuses before clearing the local verified pin", async () => {
    const calls: string[] = [];
    const localPin = pin(475);

    await expect(recoverWorkspaceCmd("/tmp/ws", { yes: true }, {
      findRoot: async () => "/tmp/ws",
      loadConfig: async () => cfg,
      loadCredentials: validCredentials,
      pinStore: () => ({
        load: async () => localPin,
        save: async () => {},
        clear: async () => calls.push("clear"),
      }),
      buildAuthedRemote: async () => {
        calls.push("build");
        return { cfg, deps: {}, remote: {} as never };
      },
      pull: async () => {
        calls.push("pull");
        throw new Error("head rolled back below the pinned sequence (rollback evident) — refusing to sync");
      },
      push: async () => {
        calls.push("push");
        return { sequence: 474, committed: false };
      },
    })).rejects.toThrow(/head rolled back below the pinned sequence/);

    expect(calls).toEqual(["build", "pull"]);
  });

  test("keep-both conflict actions are preserved and reported without local data loss", async () => {
    const logs: string[] = [];
    const pulled = [{ kind: "conflict", path: "notes.txt", keepLocalAs: "notes.conflict.txt", entry: { path: "notes.txt", type: "file", sha256: "remote", size: 5, mtimeMs: 0 } }] as const;

    await recoverWorkspaceCmd("/tmp/ws", { yes: true }, {
      findRoot: async () => "/tmp/ws",
      loadConfig: async () => cfg,
      loadCredentials: validCredentials,
      pinStore: () => ({ load: async () => undefined, save: async () => {}, clear: async () => {} }),
      buildAuthedRemote: async () => ({ cfg, deps: {}, remote: {} as never }),
      beginReport: () => ({ logSummaryTo: () => {} } as never),
      summarize: (label, actions) => {
        expect(label).toBe("pulled");
        expect(actions).toEqual(pulled);
      },
      postSyncNudge: async (_root, actions) => {
        expect(actions).toEqual(pulled);
      },
      pull: async () => [...pulled],
      push: async () => ({ sequence: 476, committed: true }),
      log: (line) => logs.push(line),
    });

    expect(logs.join("\n")).toContain("1 keep-both conflict");
  });
});
