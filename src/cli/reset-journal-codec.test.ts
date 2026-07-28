import crypto from "node:crypto";
import { describe, expect, test } from "bun:test";
import { canonicalize } from "../engine/e2ee/jcs.js";
import {
  decodeResetJournal,
  decodeResetJournalBytes,
  encodeResetJournal,
  RESET_JOURNAL_BYTE_LIMIT,
  type ResetJournalByteSource,
  type ResetJournalV2,
  type SQLiteResetJournalV2,
} from "./reset-journal-codec.js";
import { repositoryIdentityHash, type RepoIdentityV1 } from "../engine/git/repo-lineage.js";

const line = (value: unknown): Buffer =>
  Buffer.concat([Buffer.from(canonicalize(value)), Buffer.from("\n")]);
const hash = (value: Uint8Array): string =>
  crypto.createHash("sha256").update(value).digest("hex");

function legacy(): ResetJournalV2 {
  const state = {
    stream: "next", stateNonce: "2".repeat(32), stateRevision: 2,
    lastSyncedSequence: 0 as const,
    lastSyncedManifest: { generatedAt: "" as const, files: [] as [] },
    repoRecords: {},
  };
  return {
    v: 2, id: "a".repeat(32), phase: "prepared",
    createdAt: "2026-07-28T12:34:56.789Z",
    authorization: {
      version: 2, authorizedNextStream: "next",
      consentKind: "setup-rebind", mintedAtRevision: 1,
    },
    old: {
      stream: "old", stateNonce: "1".repeat(32), stateRevision: 1,
      stateSha256: "3".repeat(64), archiveBaseline: "absent", z: [],
    },
    next: {
      stream: "next", stateNonce: "2".repeat(32), stateRevision: 2,
      stateSha256: hash(line(state)), state,
    },
  };
}

function sqlite(): SQLiteResetJournalV2 {
  const dbBytes = Uint8Array.of(0x53, 0x51, 0x4c);
  return {
    v: 2, stateFormat: "sqlite/v1", id: "a".repeat(32),
    phase: "prepared", createdAt: "2026-07-28T12:34:56.789Z",
    authorization: {
      version: 2, authorizedNextStream: "next",
      consentKind: "setup-create", mintedAtRevision: 0,
    },
    authorityId: "b".repeat(32),
    sqliteApplicationId: 1380077400, sqliteUserVersion: 1,
    storeSchemaVersion: 1,
    old: {
      stream: "old", stateNonce: "1".repeat(32), stateRevision: 1,
      stateSha256: "3".repeat(64), archiveBaseline: "exact", z: [],
    },
    next: {
      stream: "next", stateNonce: "2".repeat(32), stateRevision: 2,
      stateSha256: hash(dbBytes), dbBytesB64: Buffer.from(dbBytes).toString("base64"),
      dbBytes,
    },
  };
}

describe("bounded reset journal codec", () => {
  test("round-trips both v2 branches through the exact encoder", async () => {
    for (const journal of [legacy(), sqlite()]) {
      const bytes = await encodeResetJournal(journal);
      const result = await decodeResetJournalBytes(bytes);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.rawLength).toBe(bytes.byteLength);
        expect(result.rawSha256).toBe(hash(bytes));
        expect(result.journal.v).toBe(2);
      }
    }
  });

  test("escaped duplicate names are rejected before schema construction", async () => {
    const bytes = Buffer.from('{"v":2,"\\u0076":2}');
    const result = await decodeResetJournalBytes(bytes);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "DUPLICATE_MEMBER", jsonPath: "$.v" },
    });
  });

  test("strict UTF-8 and a leading BOM have separate stable codes", async () => {
    expect(await decodeResetJournalBytes(Uint8Array.of(0xff))).toMatchObject({
      ok: false, error: { code: "UTF8_INVALID" },
    });
    expect(await decodeResetJournalBytes(Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d))).toMatchObject({
      ok: false, error: { code: "BOM_FORBIDDEN", byteOffset: 0 },
    });
  });

  test("declared length is authenticated and unknown sources stop at cap", async () => {
    const mismatch: ResetJournalByteSource = {
      declaredLength: 2,
      async readInto(destination) {
        destination[0] = 0x7b;
        return { bytesRead: 1, done: true };
      },
    };
    expect(await decodeResetJournal(mismatch)).toMatchObject({
      ok: false, error: { code: "DECLARED_LENGTH_MISMATCH" },
    });
    let supplied = 0;
    const overflow: ResetJournalByteSource = {
      declaredLength: null,
      async readInto(destination) {
        destination.fill(0x20);
        supplied += destination.byteLength;
        return { bytesRead: destination.byteLength, done: false };
      },
    };
    expect(await decodeResetJournal(overflow)).toMatchObject({
      ok: false, error: { code: "RAW_OVERFLOW" },
    });
    expect(supplied).toBe(RESET_JOURNAL_BYTE_LIMIT + 1);
  });

  test("source protocol rejects a zero-progress non-EOF read", async () => {
    const source: ResetJournalByteSource = {
      declaredLength: null,
      async readInto() { return { bytesRead: 0, done: false }; },
    };
    expect(await decodeResetJournal(source)).toMatchObject({
      ok: false, error: { code: "SOURCE_PROTOCOL" },
    });
  });

  test("source protocol authenticates permanent EOF after done", async () => {
    let calls = 0;
    const source: ResetJournalByteSource = {
      declaredLength: 2,
      async readInto(destination) {
        calls++;
        if (calls === 1) {
          destination.set(Buffer.from("{}"));
          return { bytesRead: 2, done: true };
        }
        destination[0] = 0x20;
        return { bytesRead: 1, done: true };
      },
    };
    expect(await decodeResetJournal(source)).toMatchObject({
      ok: false, error: { code: "SOURCE_PROTOCOL" },
    });
  });

  test("unknown members reject before their hostile values are scanned", async () => {
    const result = await decodeResetJournalBytes(Buffer.from('{"unknown":[[[[[[[0]]]]]]]}'));
    expect(result).toMatchObject({
      ok: false, error: { code: "UNKNOWN_MEMBER", jsonPath: "$.unknown" },
    });
  });

  test("SQLite base64 is canonical and bound to the embedded hash", async () => {
    const journal = sqlite();
    const wire = JSON.parse(Buffer.from(await encodeResetJournal(journal)).toString("utf8"));
    wire.next.stateSha256 = "0".repeat(64);
    expect(await decodeResetJournalBytes(line(wire))).toMatchObject({
      ok: false, error: { code: "EMBEDDED_HASH_MISMATCH", jsonPath: "$.next.stateSha256" },
    });
    wire.next.dbBytesB64 = "";
    expect(await decodeResetJournalBytes(line(wire))).toMatchObject({
      ok: false, error: { code: "BASE64_LENGTH" },
    });
  });

  test("pins the exact 255 / 256 / 257 Z boundary on the maximum branch", async () => {
    const entry = (index: number) => {
      const lineageHash = index.toString(16).padStart(64, "0");
      const targetOid = (index + 1).toString(16).padStart(40, "0");
      const identity: RepoIdentityV1 = {
        relPath: `repo-${index}`,
        kind: "dir",
        worktreeId: `/tmp/repo-${index}`,
        gitDirReal: `/tmp/repo-${index}/.git`,
        commonDirReal: `/tmp/repo-${index}/.git`,
        dev: "1",
        ino: String(index + 1),
        birthtime: "0",
      };
      return {
        lineageHash,
        repositoryIdentityHash: repositoryIdentityHash(identity),
        repositoryIdentity: identity,
        activeRef: `refs/rbox-local/base-absent-settled/v1/${lineageHash}`,
        targetOid,
        recoveryRef: `refs/rbox-recovery/base-absent/v1/${lineageHash}/${targetOid}`,
      };
    };
    for (const count of [255, 256]) {
      const journal = sqlite();
      journal.old.z = Array.from({ length: count }, (_, index) => entry(index + 1));
      const result = await decodeResetJournalBytes(await encodeResetJournal(journal));
      expect(result.ok).toBe(true);
    }
    const over = sqlite();
    const wire = JSON.parse(Buffer.from(await encodeResetJournal(over)).toString("utf8"));
    wire.old.z = Array.from({ length: 257 }, (_, index) => entry(index + 1));
    expect(await decodeResetJournalBytes(line(wire))).toMatchObject({
      ok: false,
      error: { code: "Z_LIMIT", jsonPath: "$.old.z", limit: 256 },
    });
  });
});
