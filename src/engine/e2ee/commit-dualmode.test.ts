import { describe, expect, test } from "bun:test";
import { generateSignKeyPair } from "./asym.js";
import { buildSignedCommit, parseCommit, type BlobRefset, type CommitFields } from "./commit.js";
import { canonicalString } from "./jcs.js";
import { sha256Hex, utf8 } from "./primitives.js";

const key = generateSignKeyPair();
const sha = (b: string) => b.repeat(64).slice(0, 64);
const base = {
  accountId: "acct_1",
  accountEpoch: 0,
  workspaceId: "ws_1",
  seq: 1,
  parentSeq: 0,
  parentCommitHash: "0".repeat(64),
  rosterVersion: 0,
  keyEpoch: 0,
  deviceId: "dev_1",
  encManifestSha: sha("e"),
};

describe("commit dual-mode body (§24.2)", () => {
  test("inline commit builds + parses, exposing blobRefs", async () => {
    const c = await buildSignedCommit({ ...base, blobRefs: [{ encSha: sha("a"), size: 1 }] } as CommitFields, key);
    const body = parseCommit(c);
    expect("blobRefs" in body).toBe(true);
    expect("blobRefset" in body).toBe(false);
  });

  test("sidecar commit builds + parses, exposing the descriptor", async () => {
    const rs: BlobRefset = { sidecarSha: sha("d"), count: 9000, totalBytes: 123 };
    const c = await buildSignedCommit({ ...base, blobRefset: rs } as CommitFields, key);
    const body = parseCommit(c);
    expect("blobRefset" in body).toBe(true);
    expect("blobRefs" in body).toBe(false);
    // The descriptor is in the SIGNED body — the signature commits to sidecarSha.
    expect(JSON.parse(c.body).blobRefset.sidecarSha).toBe(rs.sidecarSha);
  });

  // A commit carrying BOTH or NEITHER ref carrier must be rejected by parseCommit. We craft
  // such bodies directly (buildSignedCommit can't produce them) with a valid hash so the only
  // failure is the discriminator.
  async function craft(extra: Partial<Pick<CommitFields, "blobRefs" | "blobRefset">>) {
    const body = canonicalString({ type: "rbox/commit/v1", ...base, ...extra });
    const commitHash = await sha256Hex(utf8(body));
    return { body, commitHash, sig: "x" };
  }

  test("rejects a body with BOTH blobRefs and blobRefset", async () => {
    const c = await craft({ blobRefs: [{ encSha: sha("a"), size: 1 }], blobRefset: { sidecarSha: sha("d"), count: 1, totalBytes: 1 } });
    expect(() => parseCommit(c)).toThrow(/exactly one/);
  });

  test("rejects a body with NEITHER", async () => {
    const c = await craft({});
    expect(() => parseCommit(c)).toThrow(/exactly one/);
  });

  test("rejects a malformed sidecar descriptor", async () => {
    const c = await craft({ blobRefset: { sidecarSha: "nope", count: 1, totalBytes: 1 } });
    expect(() => parseCommit(c)).toThrow(/sidecarSha/);
  });
});
