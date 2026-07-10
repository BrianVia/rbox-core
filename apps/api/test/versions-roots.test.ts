import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { MAX_SNAPSHOT_RETRIES, reachableFromWorkspaces } from "../src/versions.js";

const page = (overrides: Record<string, unknown> = {}) => ({
  head: 4,
  pruneFloor: 1,
  indexGeneration: 7,
  gap: [],
  droppedPage: [],
  seqRootsPage: [],
  ...overrides,
});

function rootsEnv(fetch: (url: string) => Promise<Response>): Env {
  return {
    WORKSPACE_SYNC: { idFromName: () => ({}) as DurableObjectId, get: () => ({ fetch }) } as unknown as DurableObjectNamespace,
  } as Env;
}

describe("design 96 roots caller", () => {
  it("advances dropped and seq-root cursors independently and pins later pages", async () => {
    const urls: URL[] = [];
    const env = rootsEnv(async (raw) => {
      const url = new URL(raw);
      urls.push(url);
      if (url.searchParams.get("fromSha") === "") {
        return Response.json(page({ droppedPage: ["drop-a"], nextSha: "drop-a", seqRootsPage: [{ manifestSha: "manifest-a" }] }));
      }
      return Response.json(page({ droppedPage: ["drop-b"], seqRootsPage: [] }));
    });
    const roots = await reachableFromWorkspaces(env, [{ workspace_id: "w", project_id: "p" }]);
    expect([...roots].sort()).toEqual(["drop-a", "drop-b", "manifest-a"]);
    expect(urls).toHaveLength(2);
    expect(urls[1]!.searchParams.get("fromSeq")).toBe("done");
    expect(urls[1]!.searchParams.get("pinHead")).toBe("4");
    expect(urls[1]!.searchParams.get("pinFloor")).toBe("1");
    expect(urls[1]!.searchParams.get("pinGen")).toBe("7");
  });

  it("discards a changed snapshot and retries only that workspace", async () => {
    let calls = 0;
    const env = rootsEnv(async () => {
      calls++;
      if (calls <= MAX_SNAPSHOT_RETRIES) return Response.json({ error: "snapshot_changed" }, { status: 409 });
      return Response.json(page({ droppedPage: ["stable"] }));
    });
    expect([...(await reachableFromWorkspaces(env, [{ workspace_id: "w", project_id: "p" }]))]).toEqual(["stable"]);
    expect(calls).toBe(MAX_SNAPSHOT_RETRIES + 1);
  });

  it("fails closed after the snapshot retry budget", async () => {
    let calls = 0;
    const env = rootsEnv(async () => (calls++, Response.json({ error: "snapshot_changed" }, { status: 409 })));
    await expect(reachableFromWorkspaces(env, [{ workspace_id: "w", project_id: "p" }])).rejects.toThrow("fail-closed");
    expect(calls).toBe(MAX_SNAPSHOT_RETRIES + 1);
  });

  it("fails closed when a response stream exceeds its hard page cap", async () => {
    let calls = 0;
    const env = rootsEnv(async () => {
      calls++;
      return Response.json(page({ nextSha: `cursor-${calls}` }));
    });
    await expect(reachableFromWorkspaces(env, [{ workspace_id: "w", project_id: "p" }])).rejects.toThrow("fail-closed");
    expect(calls).toBe(16);
  });

  it("enforces the account cardinality budget during the 500k + 500k construction oracle", async () => {
    const refs = (prefix: string) => Array.from({ length: 500_000 }, (_, i) => `${prefix}${i.toString(16).padStart(63, "0")}`);
    const byWorkspace = new Map([["a/p", refs("a")], ["b/p", refs("b")]]);
    const env = {
      WORKSPACE_SYNC: {
        idFromName: (name: string) => ({ name }),
        get: (id: { name: string }) => ({
          fetch: async () => Response.json(page({
            gap: [{ manifestSha: `${id.name[0]}manifest`, inlineRefs: byWorkspace.get(id.name) }],
          })),
        }),
      },
    } as unknown as Env;

    await expect(reachableFromWorkspaces(env, [
      { workspace_id: "a", project_id: "p" },
      { workspace_id: "b", project_id: "p" },
    ])).rejects.toThrow("fail-closed");
  }, 30_000);
});
