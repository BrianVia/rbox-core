import { describe, expect, test } from "bun:test";
import type { BlobStore } from "../../engine/blobstore.js";
import type { PendingGitUpload } from "./git-state.js";
import { GIT_ARTIFACT_FLUSH_CONCURRENCY, flushGitArtifacts } from "./plan-artifacts.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function fakeStore(options: { present?: Set<string>; failing?: Set<string>; throwUndefined?: Set<string> } = {}) {
  const puts: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const store = {
    async has(encSha: string) { return options.present?.has(encSha) ?? false; },
    async putFile(encSha: string) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(20);
      inFlight--;
      if (options.failing?.has(encSha)) throw new Error("put failed " + encSha);
      if (options.throwUndefined?.has(encSha)) throw undefined;
      puts.push(encSha);
    },
  } as BlobStore;
  return { store, puts, maxInFlight: () => maxInFlight };
}

const pending = (encSha: string): PendingGitUpload => ({ encSha, ciphertextPath: "/nowhere/" + encSha, cipherSize: 1, attempts: 1 });

describe("design 317: git artifact flush", () => {
  test("uploads overlap under the bounded pool and every artifact lands in flushed", async () => {
    const { store, puts, maxInFlight } = fakeStore();
    const flushed = new Set<string>();
    await flushGitArtifacts(store, ["a", "b", "c", "d"].map(pending), flushed);
    expect(puts.sort()).toEqual(["a", "b", "c", "d"]);
    expect(flushed).toEqual(new Set(["a", "b", "c", "d"]));
    expect(maxInFlight()).toBeGreaterThanOrEqual(2);
  });

  test("a shared encSha is put once; already-flushed and already-present artifacts are skipped", async () => {
    const { store, puts } = fakeStore({ present: new Set(["present"]) });
    const flushed = new Set<string>(["done"]);
    await flushGitArtifacts(store, [pending("x"), pending("x"), pending("done"), pending("present")], flushed);
    expect(puts).toEqual(["x"]);
    expect(flushed).toEqual(new Set(["done", "x", "present"]));
  });

  test("a failing put rejects only after the in-flight siblings drained, and leaves that artifact out of flushed", async () => {
    const { store, puts } = fakeStore({ failing: new Set(["bad"]) });
    const flushed = new Set<string>();
    // More artifacts than the pool bound: "bad" fails first; the siblings already in
    // flight finish, the ones not yet started are skipped.
    const names = ["bad", ...Array.from({ length: GIT_ARTIFACT_FLUSH_CONCURRENCY + 2 }, (_, i) => "s" + i)];
    await expect(flushGitArtifacts(store, names.map(pending), flushed)).rejects.toThrow("put failed bad");
    expect(flushed.has("bad")).toBe(false);
    expect(puts.length).toBeGreaterThanOrEqual(1);
    expect(puts.length).toBeLessThan(names.length - 1);
    expect(flushed).toEqual(new Set(puts));
  });

  test("a put that rejects with undefined still fails the flush barrier", async () => {
    const { store } = fakeStore({ throwUndefined: new Set(["weird"]) });
    const flushed = new Set<string>();
    let threw = false;
    try {
      await flushGitArtifacts(store, [pending("weird"), pending("ok")], flushed);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(flushed.has("weird")).toBe(false);
  });
});
