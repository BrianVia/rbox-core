import { expect, test } from "bun:test";
import { serializeGitDeferralLanes } from "./git-deferral-json.js";

const NOW = Date.parse("2026-07-15T12:00:00.000Z");

test("lane serializer preserves the status/deferrals wire fields and checkout union", () => {
  const base = {
    lane: "apply" as const,
    reason: "local-edits" as const,
    deferredSince: "2026-07-11T12:00:00.000Z",
    reasonSince: "2026-07-15T10:00:00.000Z",
    lastSeen: "2026-07-15T11:00:00.000Z",
  };
  expect(serializeGitDeferralLanes([
    { repo: "Personal/rbox-core", deferral: { ...base, bytesChanged: true, checkout: { kind: "branch", label: "main" } } },
    { repo: "detached", deferral: { ...base, lane: "capture", checkout: { kind: "detached" } } },
    { repo: "unavailable", deferral: { ...base, lane: "config" } },
  ], NOW)).toEqual([
    { repo: "Personal/rbox-core", lane: "apply", reason: "local-edits", deferredSince: base.deferredSince, reasonSince: base.reasonSince, ageSeconds: 345_600, bytesChanged: true, checkout: { kind: "branch", label: "main" } },
    { repo: "detached", lane: "capture", reason: "local-edits", deferredSince: base.deferredSince, reasonSince: base.reasonSince, ageSeconds: 345_600, bytesChanged: false, checkout: { kind: "detached" } },
    { repo: "unavailable", lane: "config", reason: "local-edits", deferredSince: base.deferredSince, reasonSince: base.reasonSince, ageSeconds: 345_600, bytesChanged: false },
  ]);
});

test("lane serializer represents malformed and future ages as unknown null", () => {
  const deferral = { lane: "apply" as const, reason: "other" as const, deferredSince: "bad", reasonSince: "bad", lastSeen: "bad" };
  const future = { ...deferral, deferredSince: "2026-07-16T12:00:00.000Z" };
  expect(serializeGitDeferralLanes([{ repo: "bad", deferral }, { repo: "future", deferral: future }], NOW).map(({ ageSeconds }) => ageSeconds)).toEqual([null, null]);
});
