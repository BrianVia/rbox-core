import { describe, expect, test } from "bun:test";
import { ManifestChainError } from "../../engine/index.js";
import { DaemonChainRepairPolicy } from "../daemon.js";
import type { SuffixInfo } from "../chain-repair.js";

const hash = (char: string): string => char.repeat(64);

/** Minimal stand-in for repairChain's publication boundary: daemon policy is
 * consulted immediately before the repair commit. */
async function attemptRepair(
  policy: DaemonChainRepairPolicy,
  error: ManifestChainError,
  suffix: SuffixInfo[],
  publish: () => Promise<void>,
): Promise<void> {
  if (!policy.confirmSupersede(suffix)) throw policy.halt(error, suffix);
  await publish();
  policy.clear();
}

describe("daemon chain-repair policy", () => {
  test("self-authored broken suffix is automatically superseded and publishes repair", async () => {
    const policy = new DaemonChainRepairPolicy("dev_self");
    const error = new ManifestChainError("corrupt delta", { head: { seq: 8, hash: hash("a") } });
    const suffix = [
      { seq: 7, deviceId: "dev_self", reason: error.reason },
      { seq: 8, deviceId: "dev_self", reason: error.reason },
    ];
    let commits = 0;

    await attemptRepair(policy, error, suffix, async () => { commits++; });

    expect(commits).toBe(1);
    expect(() => policy.assertHeadAllowed({ commitSeq: 8, commitHash: hash("a") })).not.toThrow();
  });

  test("foreign-device suffix halts without publishing and suppresses the same broken head", async () => {
    const policy = new DaemonChainRepairPolicy("dev_self");
    const error = new ManifestChainError("missing chain link", { head: { seq: 12, hash: hash("b") } });
    const suffix = [
      { seq: 11, deviceId: "dev_foreign", reason: error.reason },
      { seq: 12, deviceId: "dev_self", reason: error.reason },
    ];
    let commits = 0;

    const first = attemptRepair(policy, error, suffix, async () => { commits++; });
    await expect(first).rejects.toThrow("MANIFEST CHAIN HALT [11:dev_foreign,12:dev_self]");
    expect(commits).toBe(0);

    // This is the daemon's guard at the start of its next pull. It must reject
    // before repairChain (and therefore its confirm/publish boundary) is entered.
    expect(() => policy.assertHeadAllowed({ commitSeq: 12, commitHash: hash("b") }))
      .toThrow("MANIFEST CHAIN HALT [11:dev_foreign,12:dev_self]");
    expect(commits).toBe(0);

    // Suppression is scoped to the authenticated {seq,hash}, not permanent.
    expect(() => policy.assertHeadAllowed({ commitSeq: 13, commitHash: hash("c") })).not.toThrow();
  });
});
