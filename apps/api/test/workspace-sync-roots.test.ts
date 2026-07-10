import { describe, expect, test, vi } from "vitest";
import { WorkspaceSync } from "../src/workspace-sync.js";

const sha = (ch: string) => ch.repeat(64);

if (!("WebSocketRequestResponsePair" in globalThis)) {
  Object.assign(globalThis, {
    WebSocketRequestResponsePair: class {
      constructor(public readonly request: string, public readonly response: string) {}
    },
  });
}

function fakeCtx(kv: Map<string, unknown>): DurableObjectState {
  return {
    storage: {
      kv: {
        get: (key: string) => kv.get(key),
        put: (key: string, value: unknown) => kv.set(key, value),
        delete: (key: string) => kv.delete(key),
        list: () => new Map(),
      },
      transactionSync: (fn: () => void) => fn(),
    },
    getWebSockets: () => [],
    setWebSocketAutoResponse: () => {},
  } as unknown as DurableObjectState;
}

function signed(seq: number, refs: { inline: string[] } | { sidecarSha: string; count: number }) {
  const carrier = "inline" in refs
    ? { blobRefs: refs.inline.map((encSha) => ({ encSha, size: 1 })) }
    : { blobRefset: { sidecarSha: refs.sidecarSha, count: refs.count, totalBytes: refs.count } };
  return JSON.stringify({
    body: JSON.stringify({
      type: "rbox/commit/v1",
      seq,
      encManifestSha: sha(String(seq)),
      ...carrier,
    }),
    commitHash: sha("c"),
    sig: "sig",
  });
}

const rootsRequest = new Request("https://do/roots?ws=ws_1&proj=root");

describe("WorkspaceSync retained-roots containment bounds", () => {
  test("returns the complete roots response when sequence and ref totals are under both bounds", async () => {
    const kv = new Map<string, unknown>([
      ["head", { sequence: 2, commitHash: sha("c") }],
      ["pruneFloor", 0],
      ["seq:1", signed(1, { inline: [sha("a")] })],
      ["seq:2", signed(2, { inline: [sha("b"), sha("d")] })],
    ]);
    const sync = new WorkspaceSync(fakeCtx(kv), {} as never);

    const res = await sync.fetch(rootsRequest);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      head: 2,
      pruneFloor: 0,
      roots: [
        { seq: 1, commitHash: sha("c"), encManifestSha: sha("1"), encShas: [sha("a")] },
        { seq: 2, commitHash: sha("c"), encManifestSha: sha("2"), encShas: [sha("b"), sha("d")] },
      ],
    });
  });

  test("returns a whole-response 503 before scanning when retained sequences exceed the bound", async () => {
    const kv = new Map<string, unknown>([["head", { sequence: 65, commitHash: sha("c") }]]);
    const sync = new WorkspaceSync(fakeCtx(kv), {} as never);

    const res = await sync.fetch(rootsRequest);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "roots_too_large", retained: 65 });
  });

  test("returns 503 before fetching the next sidecar when its declared count exceeds the cumulative ref bound", async () => {
    const get = vi.fn();
    const kv = new Map<string, unknown>([
      ["head", { sequence: 2, commitHash: sha("c") }],
      ["seq:1", signed(1, { inline: [sha("a"), sha("b")] })],
      ["seq:2", signed(2, { sidecarSha: sha("e"), count: 499_999 })],
    ]);
    const sync = new WorkspaceSync(fakeCtx(kv), { rbox_dev_blobs: { get } } as never);

    const res = await sync.fetch(rootsRequest);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "roots_too_large", retained: 2 });
    expect(get).not.toHaveBeenCalled();
  });
});
