import { expect, test } from "bun:test";
import { PhaseReport } from "../engine/index.js";
import type { SignedCommit } from "../engine/e2ee/index.js";
import { RemoteContext } from "./remote/context.js";
import { commitSigned, redeemReceipts } from "./remote/commits.js";
import { missingBlobsChunked } from "./sync-recovery.js";
import { missingPayloadBytes, timeMissingBlobs, timePushTailRequest, withPushTailTiming } from "./push-spans.js";

test("push-tail detail accumulates all missing and commit chunks with exact payload bytes", async () => {
  const report = PhaseReport.push();
  const missingBatches = [["a", "b"], ["c"], ["d"]];
  const api = { missingBlobs: async (shas: string[]) => shas };
  await withPushTailTiming(report, async () => {
    for (const batch of missingBatches) await timeMissingBlobs(api, batch);
    await timePushTailRequest("commit", 17, async () => {});
    await timePushTailRequest("commit", 29, async () => {});
  });
  const json = report.toJSON();
  expect(json.phases.missing?.details).toMatchObject({
    chunks: 3,
    payloadBytes: missingBatches.reduce((sum, batch) => sum + missingPayloadBytes(batch), 0),
  });
  expect(json.phases.commit?.details).toMatchObject({ chunks: 2, payloadBytes: 46 });
  expect(typeof json.phases.missing?.details?.chunkP95Ms).toBe("number");
  expect(report.summaryLine()).toContain("missing 0.0s chunks=3 chunkP95=");
  expect(report.summaryLine()).toContain("commit 0.0s chunks=2 chunkP95=");
});

test("production transport deduplicates wrapped probes and counts only commit-enclosed receipt drains", async () => {
  const report = PhaseReport.push();
  report.recordDetails("missing", { introduced: 1 }, "i1r2s3fa0");
  report.recordDetails("commit", { postMs: 4 }, "r0.1 sc0.2 e0.3 c0.4 u0.5 p0.6 srv0.7");
  const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  const commit: SignedCommit = { body: "{}", commitHash: "a".repeat(64), sig: "sig" };
  const commitPayloads: number[] = [];
  let manifests = 0;
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async (url, init) => {
    const bytes = Buffer.byteLength(String(typeof init === "function" ? init().body : init.body));
    if (url.endsWith("/blobs/check")) return new Response(JSON.stringify({ missing: [] }), { status: 200 });
    if (url.endsWith("/receipts/redeem")) {
      commitPayloads.push(bytes);
      return new Response(JSON.stringify({ granted: 1, alreadyEntitled: 0, rejected: 0 }), { status: 200 });
    }
    commitPayloads.push(bytes);
    manifests++;
    return new Response(JSON.stringify(manifests === 1 ? { head: 1 } : { sequence: 2 }), { status: manifests === 1 ? 409 : 200 });
  };
  ctx.receipts.set("b".repeat(64), "upload-time");
  await withPushTailTiming(report, async () => {
    await timeMissingBlobs(ctx, ["one"]); // wrapper + RemoteContext hook count once
    await ctx.missingBlobs(["two"]); // central hook covers multipart/Git callers
    await redeemReceipts(ctx); // upload-time drain is deliberately not commit detail
    ctx.receipts.set("c".repeat(64), "final-drain");
    expect(await commitSigned(ctx, 0, commit)).toMatchObject({ conflict: true });
    expect(await commitSigned(ctx, 1, commit)).toMatchObject({ sequence: 2 });
  });
  expect(report.toJSON().phases.missing?.details).toMatchObject({ chunks: 2 });
  expect(report.toJSON().phases.commit?.details).toMatchObject({
    chunks: 3,
    payloadBytes: commitPayloads.slice(1).reduce((sum, bytes) => sum + bytes, 0),
  });
  const summary = report.summaryLine();
  expect(summary).toContain("i1r2s3fa0 chunks=2");
  expect(summary).toContain("r0.1 sc0.2 e0.3 c0.4 u0.5 p0.6 srv0.7 chunks=3");
});

test("50,001-address legacy audit records two exact missing chunks", async () => {
  const report = PhaseReport.push();
  const calls: string[][] = [];
  const shas = Array.from({ length: 50_001 }, (_, index) => index.toString(16).padStart(64, "0"));
  await withPushTailTiming(report, () => missingBlobsChunked({
    missingBlobs: async (batch: string[]) => { calls.push(batch); return []; },
  } as never, shas));
  expect(calls.map((batch) => batch.length)).toEqual([50_000, 1]);
  expect(report.toJSON().phases.missing?.details).toMatchObject({
    chunks: 2,
    payloadBytes: calls.reduce((sum, batch) => sum + missingPayloadBytes(batch), 0),
  });
});
