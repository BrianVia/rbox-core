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

const pin = (seq: number, hash = `${seq}`.padStart(64, "0")): HeadPin => ({
  commitSeq: seq,
  commitHash: hash,
  rosterVersion: 1,
  rosterHash: "r".repeat(64),
  accountEpoch: 1,
  keyStateHash: "k".repeat(64),
});

describe("recover workspace command", () => {
  test("chain failure retains the newly verified head and requires suffix consent", async () => {
    let currentPin: HeadPin | undefined = pin(4);
    let confirmations = 0;
    let repaired = 0;
    const broken = new ManifestChainError("corrupt delta", { head: { seq: 6, hash: "b".repeat(64) }, failingLink: "c".repeat(64) });
    await recoverWorkspaceCmd("/tmp/ws", { yes: true }, {
      findRoot: async () => "/tmp/ws",
      loadConfig: async () => cfg,
      loadCredentials: async () => ({ token: "tok", deviceId: "dev_1", remoteUrl: "https://api.test", accountId: "acct_1" }),
      latestCommit: async () => ({ sequence: 6 }),
      pinStore: () => ({
        load: async () => currentPin,
        save: async (next) => { currentPin = next; },
        clear: async () => { currentPin = undefined; },
      }),
      buildAuthedRemote: async () => ({ cfg, deps: {}, remote: {} as never }),
      chainProbe: async () => { currentPin = pin(6, "b".repeat(64)); throw broken; },
      beginReport: () => ({ logSummaryTo: () => {} } as never),
      pull: async () => { throw new Error("pull must not run after a failed retained-pin probe"); },
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
      loadCredentials: async () => ({ token: "tok", deviceId: "dev_1", remoteUrl: "https://api.test", accountId: "acct_1" }),
      latestCommit: async () => ({ sequence: 3 }),
      pinStore: () => ({ load: async () => currentPin, save: async (next) => { currentPin = next; }, clear: async () => { currentPin = undefined; } }),
      buildAuthedRemote: async () => ({ cfg, deps: {}, remote: {} as never }),
      chainProbe: async () => { currentPin = pin(3, "d".repeat(64)); throw broken; },
      beginReport: () => ({ logSummaryTo: () => {} } as never),
      pull: async () => { throw new Error("pull must not run after a failed retained-pin probe"); },
      confirm: async () => true,
      repair: async (_root, _cfg, _deps, _error, opts) => {
        expect(await opts.confirmSupersede([{ seq: 3, deviceId: "dev_1", reason: "missing link" }])).toBe(true);
        return { kind: "repaired", sequence: 4, suffix: [], actions: [] };
      },
      log: () => {},
    });
    expect(currentPin?.commitSeq).toBe(3);
  });

  test("clears the keystore pin, pulls/reconciles, then pushes local diffs", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const depsObj: SyncDeps = {};

    await recoverWorkspaceCmd("/tmp/ws", { yes: true }, {
      findRoot: async () => "/tmp/ws",
      loadConfig: async () => cfg,
      loadCredentials: async () => ({ token: "tok", deviceId: "dev_1", remoteUrl: "https://api.test", accountId: "acct_1" }),
      pinStore: (accountId, workspaceId) => ({
        load: async () => undefined,
        save: async () => {},
        clear: async () => calls.push(`clear:${accountId}:${workspaceId}`),
      }),
      buildAuthedRemote: async () => ({ cfg, deps: depsObj, remote: {} as never }),
      chainProbe: async () => calls.push("probe"),
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

    expect(calls).toEqual(["probe", "clear:acct_1:ws_1", "pull", "summarize", "nudge", "push"]);
    expect(depsObj.allowMassDelete).toBe(false);
    expect(logs.join("\n")).toContain("pin cleared");
    expect(logs.join("\n")).toContain("1 pulled");
  });

  test("forked or halted pin state clears, re-baselines, and reconciles", async () => {
    const calls: string[] = [];
    let currentPin: HeadPin | undefined = pin(474, "a".repeat(64));

    await recoverWorkspaceCmd("/tmp/ws", { yes: true }, {
      findRoot: async () => "/tmp/ws",
      loadConfig: async () => cfg,
      loadCredentials: async () => ({ token: "tok", deviceId: "dev_1", remoteUrl: "https://api.test", accountId: "acct_1" }),
      latestCommit: async () => ({ sequence: 475 }),
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
      buildAuthedRemote: async () => ({ cfg, deps: {}, remote: {} as never }),
      chainProbe: async () => calls.push("probe"),
      beginReport: () => ({ logSummaryTo: () => {} } as never),
      summarize: () => calls.push("summarize"),
      postSyncNudge: async () => calls.push("nudge"),
      pull: async () => {
        calls.push("pull");
        return [{ kind: "write", entry: { path: "server.txt", type: "file", sha256: "srv", size: 6, mtimeMs: 0 } }];
      },
      push: async () => {
        calls.push("push");
        return { sequence: 475, committed: false };
      },
      log: () => {},
    });

    expect(calls).toEqual(["probe", "clear", "pull", "summarize", "nudge", "push"]);
    expect(currentPin).toBeUndefined();
  });

  test("true rollback refuses before clearing the local verified pin", async () => {
    const calls: string[] = [];
    const localPin = pin(475);

    await expect(recoverWorkspaceCmd("/tmp/ws", { yes: true }, {
      findRoot: async () => "/tmp/ws",
      loadConfig: async () => cfg,
      loadCredentials: async () => ({ token: "tok", deviceId: "dev_1", remoteUrl: "https://api.test", accountId: "acct_1" }),
      latestCommit: async () => ({ sequence: 474 }),
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
        return [];
      },
      push: async () => {
        calls.push("push");
        return { sequence: 474, committed: false };
      },
    })).rejects.toThrow(/server head sequence 474 is below the local verified pin 475/);

    expect(calls).toEqual([]);
  });

  test("keep-both conflict actions are preserved and reported without local data loss", async () => {
    const logs: string[] = [];
    const pulled = [{ kind: "conflict", path: "notes.txt", keepLocalAs: "notes.conflict.txt", entry: { path: "notes.txt", type: "file", sha256: "remote", size: 5, mtimeMs: 0 } }] as const;

    await recoverWorkspaceCmd("/tmp/ws", { yes: true }, {
      findRoot: async () => "/tmp/ws",
      loadConfig: async () => cfg,
      loadCredentials: async () => ({ token: "tok", deviceId: "dev_1", remoteUrl: "https://api.test", accountId: "acct_1" }),
      pinStore: () => ({ load: async () => undefined, save: async () => {}, clear: async () => {} }),
      buildAuthedRemote: async () => ({ cfg, deps: {}, remote: {} as never }),
      chainProbe: async () => {},
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
