import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pull, push, pushManifest, sync, type SyncDeps } from "./sync.js";
import type { WorkspaceConfig } from "./config.js";
import { loadState, syncStreamId } from "./config.js";
import { BlobShaMismatchError, type CommitResult, type SyncRemote } from "./remote.js";
import { PhaseReport, scanManifest, type BlobStore, type FileEntry, type Manifest } from "../engine/index.js";
import { encryptFileNameProbe } from "../engine/e2ee/e2ee-e2e.helpers.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const shaBytes = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// Fixed test workspace KEK — E2EE is the only sync mode now (design 12 D6), so the
// FakeRemote operates at the blob layer in CIPHERTEXT (by encSha) exactly as the
// real server does; manifests are the post-decryption plaintext view the transport
// hands sync.ts. `enc()` mirrors the V4-5 convergent blob derivation.
const KEK = Buffer.alloc(32, 7);
const enc = (content: string | Buffer) => encryptFileNameProbe(new Uint8Array(KEK), new Uint8Array(Buffer.from(content)));

/**
 * Stateful in-memory server simulator (design 09 §1) — monotonic head, 409 parent
 * conflict, 422 blob-existence. Blobs are content-addressed by `encSha` (ciphertext)
 * since the client always encrypts; manifests are plaintext (the transport decrypts
 * before sync.ts sees them).
 */
class FakeRemote implements SyncRemote {
  private head = 0;
  private readonly log = new Map<number, Manifest>(); // seq → manifest
  private readonly blobs = new Map<string, Buffer>(); // encSha → ciphertext
  commitCalls = 0;
  forceUnsatisfiedOnce = false;
  forceUnsatisfiedTotals: number[] = [];
  forceUnsatisfiedPageSize = 1;
  beforeCommit?: () => Promise<void>;
  // Live-folder TOCTOU simulation: reject a given encSha's PUT with a 400 sha_mismatch
  // (as R2 does when the streamed ciphertext no longer hashes to the declared encSha).
  // `…Once` clears itself after firing (heals on retry); `…Always` never clears (a file
  // that keeps changing — exercises the bounded-retry give-up).
  forceShaMismatchOnce?: string;
  forceShaMismatchAlways?: string;

  /** Encrypt + seed a blob (as the uploading client would); return its FileEntry. */
  async seedEntry(rel: string, content: string): Promise<FileEntry> {
    const p = await enc(content);
    this.blobs.set(p.encSha, Buffer.from(p.ciphertext));
    return { path: rel, type: "file", sha256: p.plaintextSha, encSha: p.encSha, size: content.length, mode: 0o644, mtimeMs: 1 };
  }
  injectCommit(files: FileEntry[]): void {
    this.head += 1;
    this.log.set(this.head, { generatedAt: "", files });
  }
  headSeq(): number {
    return this.head;
  }
  hasBlob(encSha: string): boolean {
    return this.blobs.has(encSha);
  }

  async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    return { sequence: this.head, manifest: this.log.get(this.head) ?? { generatedAt: "", files: [] } };
  }
  async missingBlobs(shas: string[]): Promise<string[]> {
    return shas.filter((s) => !this.blobs.has(s));
  }
  async putBlobFile(sha256: string, absPath: string): Promise<void> {
    if (this.forceShaMismatchAlways === sha256) throw new BlobShaMismatchError(sha256);
    if (this.forceShaMismatchOnce === sha256) {
      this.forceShaMismatchOnce = undefined; // heal on the re-scan retry
      throw new BlobShaMismatchError(sha256);
    }
    const bytes = await fs.readFile(absPath); // ciphertext; encSha = sha256(ciphertext)
    if (shaBytes(bytes) !== sha256) throw new Error(`putBlobFile: content/sha mismatch for ${sha256}`);
    this.blobs.set(sha256, bytes);
  }
  async commit(parentSequence: number, _deviceId: string, manifest: Manifest): Promise<CommitResult> {
    this.commitCalls += 1;
    if (this.beforeCommit) await this.beforeCommit();
    if (parentSequence !== this.head) return { conflict: true, head: this.head };
    // Blob-existence is checked against the STORED address: encSha (ciphertext).
    const addr = (f: FileEntry) => f.encSha ?? f.sha256;
    const missing = manifest.files.filter((f) => f.type === "file").map(addr).filter((s) => !this.blobs.has(s));
    if (missing.length > 0) return { unsatisfiedBlobs: [...new Set(missing)] };
    if (this.forceUnsatisfiedTotals.length > 0) {
      const total = this.forceUnsatisfiedTotals.shift()!;
      const page = [...new Set(manifest.files.filter((f) => f.type === "file").map(addr))].slice(0, this.forceUnsatisfiedPageSize);
      return { unsatisfiedBlobs: page, unsatisfiedTotal: total };
    }
    if (this.forceUnsatisfiedOnce) {
      this.forceUnsatisfiedOnce = false;
      return { unsatisfiedBlobs: manifest.files.filter((f) => f.type === "file").map(addr) };
    }
    this.head += 1;
    this.log.set(this.head, manifest);
    return { sequence: this.head };
  }
  blobStore(): BlobStore {
    const blobs = this.blobs;
    return {
      async has(s) {
        return blobs.has(s);
      },
      async put(s, bytes) {
        blobs.set(s, Buffer.from(bytes));
      },
      async get(s) {
        const b = blobs.get(s);
        if (!b) throw new Error(`blob missing: ${s}`);
        return b;
      },
      async getToFile(s, dest) {
        const b = blobs.get(s);
        if (!b) throw new Error(`blob missing: ${s}`);
        await fs.writeFile(dest, b);
      },
      async putFile(s, src) {
        blobs.set(s, await fs.readFile(src));
      },
    };
  }
}

let root: string;
let cfg: WorkspaceConfig;
const noBackoff = async () => {};
const deps = (remote: SyncRemote): SyncDeps => ({ remote, backoff: noBackoff });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-sync-test-"));
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  // E2EE is the only mode (D6): a workspace always has an encryption key.
  cfg = { remoteWorkspaceId: "ws_t", projectId: "root", deviceId: "devA", rootPath: root, remoteUrl: "http://x", token: "", encrypted: true, kek: KEK };
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const write = (rel: string, content: string) => fs.writeFile(path.join(root, rel), content);
const read = (rel: string) => fs.readFile(path.join(root, rel), "utf8");

// ── echo-storm no-op (the guard that makes continuous sync viable) ──────────

test("no-op: pull-then-push with no local changes makes ZERO commits, sequence stable", async () => {
  const remote = new FakeRemote();
  const c = "hello\n";
  remote.injectCommit([await remote.seedEntry("a.txt", c)]);

  await pull(root, cfg, deps(remote)); // writes a.txt (decrypted), base → seq 1
  expect(await read("a.txt")).toBe(c);
  const before = remote.commitCalls;
  const { sequence: seq } = await push(root, cfg, deps(remote)); // nothing changed on disk
  expect(remote.commitCalls).toBe(before); // ZERO new commits — no echo
  expect(seq).toBe(1);
  expect(remote.headSeq()).toBe(1);
});

test("pull never applies a remote entry that LOCAL rules ignore (legacy .git pointer files)", async () => {
  const remote = new FakeRemote();
  // An OLD client synced a worktree `.git` pointer file before `.git` (file form)
  // became a builtin ignore. It's still in the remote manifest.
  remote.injectCommit([
    await remote.seedEntry("ok.txt", "fine\n"),
    await remote.seedEntry("wt/.git", "gitdir: /Users/old-machine/repo/.git/worktrees/wt\n"),
  ]);
  // This machine has a REAL, machine-local pointer at that path — it must survive.
  await fs.mkdir(path.join(root, "wt"), { recursive: true });
  await write("wt/.git", "gitdir: /Users/me/repo/.git/worktrees/wt\n");

  await pull(root, cfg, deps(remote));
  expect(await read("ok.txt")).toBe("fine\n"); // non-ignored entries still apply
  expect(await read("wt/.git")).toBe("gitdir: /Users/me/repo/.git/worktrees/wt\n"); // untouched

  // The ignored remote entry stays in the recorded BASE (forward-only), so the next
  // push neither echo-deletes it from the remote nor commits anything at all.
  const st = await loadState(root, syncStreamId(cfg));
  expect(st.lastSyncedManifest.files.some((f) => f.path === "wt/.git")).toBe(true);
  const before = remote.commitCalls;
  await push(root, cfg, deps(remote));
  expect(remote.commitCalls).toBe(before); // zero commits — no echo
  expect(remote.headSeq()).toBe(1);
});

test("a pull that RELAXES ignore rules applies the newly-unignored files (two-phase matcher)", async () => {
  // Filtering every action through the PRE-pull matcher would drop foo.txt here —
  // it would never land locally and the next push would delete it from the remote
  // (codex round-3 repro). Rule-file actions must apply first, then a FRESH matcher
  // filters the rest.
  const remote = new FakeRemote();
  remote.injectCommit([await remote.seedEntry(".rboxignore", "foo.txt\n")]);
  await pull(root, cfg, deps(remote)); // base: rules ignore foo.txt

  // seq 2: the rules are relaxed (ignore file removed) AND foo.txt is added.
  remote.injectCommit([await remote.seedEntry("foo.txt", "now visible\n")]);
  await pull(root, cfg, deps(remote));
  expect(await read("foo.txt")).toBe("now visible\n"); // landed despite the old rules

  const before = remote.commitCalls;
  await push(root, cfg, deps(remote));
  expect(remote.commitCalls).toBe(before); // and no echo commit afterwards
  expect(remote.headSeq()).toBe(2);
});

// ── clean push ─────────────────────────────────────────────────────────────

test("clean push uploads the ciphertext blob, commits, advances base", async () => {
  const remote = new FakeRemote();
  await write("new.txt", "fresh content\n");
  const { sequence: seq } = await push(root, cfg, deps(remote));
  expect(seq).toBe(1);
  expect(remote.hasBlob((await enc("fresh content\n")).encSha)).toBe(true); // stored as ciphertext
  expect(remote.hasBlob(sha("fresh content\n"))).toBe(false); // never the plaintext address
  expect((await loadState(root, syncStreamId(cfg))).lastSyncedSequence).toBe(1);
});

test("binary (non-UTF8) content is encrypted + byte-verified by ciphertext address", async () => {
  const remote = new FakeRemote();
  const binary = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x7f, 0xc3, 0x28]);
  await fs.writeFile(path.join(root, "blob.bin"), binary);
  const { sequence: seq } = await push(root, cfg, deps(remote));
  expect(seq).toBe(1);
  expect(remote.hasBlob((await enc(binary)).encSha)).toBe(true); // ciphertext addressed correctly
});

// ── 409 conflict-retry: the rescan is load-bearing ─────────────────────────

test("409 conflict: client pulls + RE-SCANS + retries, and does NOT lose the remote change", async () => {
  const remote = new FakeRemote();
  await write("mine.txt", "mine\n");
  const theirs = "theirs\n";
  let injected = false;
  remote.beforeCommit = async () => {
    if (!injected) {
      injected = true;
      remote.injectCommit([await remote.seedEntry("theirs.txt", theirs)]);
    }
  };
  const { sequence: seq } = await push(root, cfg, deps(remote));
  expect(await read("theirs.txt")).toBe(theirs); // remote change not clobbered
  expect(await read("mine.txt")).toBe("mine\n"); // our change preserved
  expect(seq).toBe(remote.headSeq());
  expect(remote.commitCalls).toBeGreaterThanOrEqual(2);
});

// ── 409 give-up leaves state untouched ─────────────────────────────────────

test("409 forever: exhausts retries, throws, never commits our change, never loses it", async () => {
  const remote = new FakeRemote();
  await write("mine.txt", "mine\n");
  let n = 0;
  remote.beforeCommit = async () => {
    n++;
    remote.injectCommit([await remote.seedEntry(`o${n}.txt`, `other${n}\n`)]);
  };
  await expect(push(root, cfg, deps(remote))).rejects.toThrow(/too many conflicts/);
  const latest = await remote.latest();
  expect(latest.manifest.files.some((f) => f.path === "mine.txt")).toBe(false); // never committed
  expect(await read("mine.txt")).toBe("mine\n"); // never lost
});

test("onCommitConflict fires once per 409 (the metric the daemon tallies)", async () => {
  const remote = new FakeRemote();
  await write("mine.txt", "mine\n");
  let injected = 0;
  remote.beforeCommit = async () => {
    if (injected < 2) {
      injected++;
      remote.injectCommit([await remote.seedEntry(`o${injected}.txt`, `o${injected}\n`)]);
    }
  };
  let conflicts = 0;
  await push(root, cfg, { remote, backoff: noBackoff, onCommitConflict: () => conflicts++ });
  expect(conflicts).toBe(2);
});

// ── 422 unsatisfied-blobs → reupload + retry ───────────────────────────────

test("422 unsatisfied blobs: client re-uploads and retries to success", async () => {
  const remote = new FakeRemote();
  await write("x.txt", "payload\n");
  remote.forceUnsatisfiedOnce = true;
  const { sequence: seq } = await push(root, cfg, deps(remote));
  expect(seq).toBe(1);
  expect(remote.commitCalls).toBe(2); // 422 then success
});

test("422 decreasing missingTotal pages can progress beyond the fixed retry budget", async () => {
  const remote = new FakeRemote();
  await write("x.txt", "payload\n");
  remote.forceUnsatisfiedTotals = [60_000, 50_000, 40_000, 30_000, 20_000, 10_000];

  const { sequence: seq } = await push(root, cfg, deps(remote));

  expect(seq).toBe(1);
  expect(remote.commitCalls).toBe(7); // six capped 422 pages, then success
});

test("422 non-decreasing missingTotal still exhausts the existing retry budget", async () => {
  const remote = new FakeRemote();
  await write("x.txt", "payload\n");
  remote.forceUnsatisfiedTotals = Array.from({ length: 10 }, () => 10_000);

  await expect(push(root, cfg, deps(remote))).rejects.toThrow(/server keeps reporting missing blobs/);
  expect(remote.headSeq()).toBe(0);
  expect(remote.commitCalls).toBe(6);
});

// ── live-folder TOCTOU: 400 sha_mismatch → re-scan + retry (self-heal) ──────

test("sha_mismatch once: a file that changes under the push RE-SCANS + retries + commits (does NOT abort)", async () => {
  const remote = new FakeRemote();
  const content = "live edit in progress\n";
  await write("f.txt", content);
  // The server rejects the first PUT of this ciphertext (as if the source moved between
  // encrypt-time and the streamed upload); the client must not abort the whole push.
  remote.forceShaMismatchOnce = (await enc(content)).encSha;

  const { sequence: seq } = await push(root, cfg, deps(remote));

  expect(seq).toBe(1); // committed — the push self-healed
  expect(remote.headSeq()).toBe(1);
  expect(remote.hasBlob((await enc(content)).encSha)).toBe(true); // ciphertext landed on retry
  expect((await remote.latest()).manifest.files.some((f) => f.path === "f.txt")).toBe(true);
});

// ── live-folder partial progress: a churning file is DEFERRED, the rest commits ──

test("a file that NEVER settles is deferred; the push SUCCEEDS committing the OTHER (stable) files", async () => {
  const remote = new FakeRemote();
  await write("stable.txt", "stable content\n");
  await write("churner.txt", "never settles\n");
  // The churner's ciphertext is rejected on every attempt (it keeps changing under us);
  // its bounded per-file retries exhaust → it's deferred, NOT a whole-push abort.
  remote.forceShaMismatchAlways = (await enc("never settles\n")).encSha;

  const local = await scanManifest(root, undefined, undefined);
  const res = await pushManifest(root, cfg, local, deps(remote));

  expect(res.sequence).toBe(1); // committed — the push made progress (did not abort)
  expect(remote.headSeq()).toBe(1);
  expect(res.deferred).toEqual(["churner.txt"]); // the churner is reported as deferred (count/paths)

  const committed = (await remote.latest()).manifest;
  expect(committed.files.some((f) => f.path === "churner.txt")).toBe(false); // never-synced deferred → OMITTED
  expect(committed.files.some((f) => f.path === "stable.txt")).toBe(true); // the stable file committed
  expect(remote.hasBlob((await enc("stable content\n")).encSha)).toBe(true);
  // Invariant: the committed manifest references no blob that isn't present on the server.
  for (const f of committed.files) if (f.type === "file") expect(remote.hasBlob(f.encSha!)).toBe(true);
});

test("a file that VANISHES between scan and encrypt is deferred; the push commits the rest", async () => {
  const remote = new FakeRemote();
  await write("stable.txt", "stable content\n");
  await write("ghost.txt", "about to vanish\n");

  const local = await scanManifest(root, undefined, undefined);
  await fs.rm(path.join(root, "ghost.txt")); // vanished after scan, before encrypt (agent/build churn)
  const res = await pushManifest(root, cfg, local, deps(remote));

  expect(res.sequence).toBe(1); // committed — one vanished file must not abort the push
  expect(res.deferred).toEqual(["ghost.txt"]);
  const committed = (await remote.latest()).manifest;
  expect(committed.files.some((f) => f.path === "ghost.txt")).toBe(false); // never-synced → omitted
  expect(committed.files.some((f) => f.path === "stable.txt")).toBe(true);
  for (const f of committed.files) if (f.type === "file") expect(remote.hasBlob(f.encSha!)).toBe(true);
});

test("a mismatch ONCE then settles is INCLUDED (bounded per-file retry heals it, not deferred)", async () => {
  const remote = new FakeRemote();
  const content = "flickers once\n";
  await write("f.txt", content);
  remote.forceShaMismatchOnce = (await enc(content)).encSha; // 400s once, then heals

  const local = await scanManifest(root, undefined, undefined);
  const res = await pushManifest(root, cfg, local, deps(remote));

  expect(res.sequence).toBe(1);
  expect(res.deferred).toEqual([]); // healed on retry → NOT deferred
  expect((await remote.latest()).manifest.files.some((f) => f.path === "f.txt")).toBe(true);
});

test("a previously-synced file that starts churning carries its BASE version (never a deletion)", async () => {
  const remote = new FakeRemote();
  await write("doc.txt", "v1\n");
  await push(root, cfg, deps(remote)); // doc.txt synced at v1
  expect((await remote.latest()).manifest.files.some((f) => f.path === "doc.txt")).toBe(true);

  // doc.txt now churns to v2 whose ciphertext never lands; a sibling changes cleanly.
  await write("doc.txt", "v2\n");
  await write("other.txt", "fresh\n");
  remote.forceShaMismatchAlways = (await enc("v2\n")).encSha;

  const local = await scanManifest(root, undefined, undefined);
  const res = await pushManifest(root, cfg, local, deps(remote));

  expect(res.deferred).toEqual(["doc.txt"]);
  const committed = (await remote.latest()).manifest;
  const doc = committed.files.find((f) => f.path === "doc.txt");
  expect(doc).toBeDefined(); // carried forward — NOT read as a deletion on other machines
  expect(doc!.sha256).toBe(sha("v1\n")); // its BASE (v1) entry, not the un-uploadable v2
  expect(remote.hasBlob(doc!.encSha!)).toBe(true); // the carried base blob is present
  expect(committed.files.some((f) => f.path === "other.txt")).toBe(true); // sibling committed
});

test("convergent duplicates (identical content) commit under ONE shared blob, both paths present", async () => {
  const remote = new FakeRemote();
  const content = "shared bytes\n";
  await write("a.txt", content);
  await write("b.txt", content); // identical → same encSha (convergent)

  const local = await scanManifest(root, undefined, undefined);
  const res = await pushManifest(root, cfg, local, deps(remote));

  expect(res.deferred).toEqual([]);
  const committed = (await remote.latest()).manifest;
  expect(committed.files.some((f) => f.path === "a.txt")).toBe(true);
  expect(committed.files.some((f) => f.path === "b.txt")).toBe(true);
  const encSha = (await enc(content)).encSha;
  expect(committed.files.filter((f) => f.type === "file").every((f) => f.encSha === encSha)).toBe(true);
  expect(remote.hasBlob(encSha)).toBe(true);
});

test("when EVERY change is deferred and git is unchanged, the push makes NO (empty) commit", async () => {
  const remote = new FakeRemote();
  await write("churner.txt", "never\n");
  remote.forceShaMismatchAlways = (await enc("never\n")).encSha;

  const before = remote.commitCalls;
  const local = await scanManifest(root, undefined, undefined);
  const res = await pushManifest(root, cfg, local, deps(remote));

  expect(remote.commitCalls).toBe(before); // no commit attempted — nothing stable to commit
  expect(res.sequence).toBe(0); // base sequence unchanged
  expect(res.deferred).toEqual(["churner.txt"]);
});

// ── pull validation: invalid remote manifest never touches disk / base ──────

test("pull rejects an invalid remote manifest and does not advance base", async () => {
  const remote = new FakeRemote();
  // Path-traversal entry (invalid) at head — rejected by client-side validation
  // BEFORE any blob fetch/decrypt (the client is the sole validator under E2EE).
  remote.injectCommit([{ path: "../escape", type: "file", sha256: sha("x"), encSha: sha("x"), size: 1, mode: 0o644, mtimeMs: 1 }]);
  await expect(pull(root, cfg, deps(remote))).rejects.toThrow(/invalid remote manifest/);
  expect((await loadState(root, syncStreamId(cfg))).lastSyncedSequence).toBe(0); // base unchanged
});

// ── forward-only ignore carry (M3b) ────────────────────────────────────────

test("a now-ignored, previously-synced file is carried forward (not seen as a deletion)", async () => {
  const remote = new FakeRemote();
  await write("keep.env", "K=V\n");
  await push(root, cfg, deps(remote));
  expect((await remote.latest()).manifest.files.some((f) => f.path === "keep.env")).toBe(true);
  await write(".rboxignore", "keep.env\n");
  await push(root, cfg, deps(remote));
  const latest = await remote.latest();
  expect(latest.manifest.files.some((f) => f.path === "keep.env")).toBe(true); // carried forward
});

// ── full sync cycle ────────────────────────────────────────────────────────

test("sync = pull then push in one call", async () => {
  const remote = new FakeRemote();
  remote.injectCommit([await remote.seedEntry("r.txt", "remote\n")]);
  await write("local.txt", "local\n");
  const { pulled, pushedSequence } = await sync(root, cfg, deps(remote));
  expect(pulled.some((a) => a.kind === "write")).toBe(true); // pulled r.txt
  expect(await read("r.txt")).toBe("remote\n");
  expect(pushedSequence).toBe(remote.headSeq()); // pushed local.txt on top
});

// ── §35 phase metrics: an enabled report is populated across the real phases ──

test("§35: an enabled report times push phases and attributes the byte bases", async () => {
  const remote = new FakeRemote();
  const content = "payload\n";
  await write("x.txt", content);

  const report = PhaseReport.push();
  await push(root, cfg, { remote, backoff: noBackoff, report });

  const j = report.toJSON();
  // Every coarse push phase was timed (scan from push(), the rest from pushManifest).
  expect(Object.keys(j.phases).sort()).toEqual(["commit", "encrypt", "scan", "upload"]);
  expect(j.files).toBe(1);
  expect(j.blobs).toBe(1);
  // Bases attributed to the right phase: plaintext on scan, ciphertext/changed on
  // encrypt, wire on upload — each strictly positive for a real one-file push.
  expect(j.phases.scan!.plaintextBytes).toBe(Buffer.byteLength(content));
  expect(j.phases.encrypt!.count).toBe(1);
  expect(j.phases.encrypt!.ciphertextBytes).toBeGreaterThan(0);
  expect(j.phases.encrypt!.changedBytes).toBe(j.phases.encrypt!.ciphertextBytes);
  expect(j.phases.upload!.wireBytes).toBeGreaterThan(0);
  // The summary line is emitted (a phase was recorded) and stays PII-free.
  const lines: string[] = [];
  report.logSummaryTo((l) => lines.push(l));
  expect(lines.length).toBe(1);
  expect(lines[0]).not.toContain("x.txt");
});

test("§35: an enabled report times pull phases (scan + apply) with plaintext bytes", async () => {
  const remote = new FakeRemote();
  const content = "remote\n";
  remote.injectCommit([await remote.seedEntry("r.txt", content)]);

  const report = PhaseReport.pull();
  await pull(root, cfg, { remote, backoff: noBackoff, report });

  const j = report.toJSON();
  expect(Object.keys(j.phases).sort()).toEqual(["apply", "scan"]);
  expect(j.blobs).toBe(1); // one write action applied
  expect(j.phases.apply!.plaintextBytes).toBe(Buffer.byteLength(content));
});

test("§35: with no report, the sync path is unaffected (disabled fallback records nothing)", async () => {
  const remote = new FakeRemote();
  await write("y.txt", "z\n");
  // No `report` in deps → sync uses PhaseReport.disabled internally; push still works.
  const { sequence: seq } = await push(root, cfg, deps(remote));
  expect(seq).toBe(1);
});

// ── design 44: rebind state-poisoning + the mass-delete guard ────────────────
// Incident (2026-07-01): `rbox setup` rebound a synced root to a brand-new EMPTY
// workspace while the old 8,600-file baseline survived in state.json — the next
// pull read every baseline file as "remotely deleted" and wiped the local tree.
// These tests pin the two independent layers that each prevent a recurrence.

test("REBIND regression: a root rebound to a new EMPTY workspace pulls without deleting, then publishes the full tree", async () => {
  const remoteOld = new FakeRemote();
  await write("a.txt", "aaa\n");
  await write("b.txt", "bbb\n");
  await push(root, cfg, deps(remoteOld)); // baseline now belongs to ws_t

  // Rebind: same root + stale state.json, different workspace, empty remote —
  // exactly what `setup → create new workspace` does over an already-synced dir.
  const cfgNew: WorkspaceConfig = { ...cfg, remoteWorkspaceId: "ws_new" };
  const remoteNew = new FakeRemote();
  const actions = await pull(root, cfgNew, deps(remoteNew));
  expect(actions.filter((a) => a.kind === "delete")).toHaveLength(0); // NEVER deletes
  expect(await read("a.txt")).toBe("aaa\n");
  expect(await read("b.txt")).toBe("bbb\n");

  // And the first push to the new workspace is a REAL publish of everything.
  const { sequence, committed } = await push(root, cfgNew, deps(remoteNew));
  expect(committed).toBe(true);
  expect(sequence).toBe(1);
  const published = (await remoteNew.latest()).manifest.files.map((f) => f.path).sort();
  expect(published).toEqual(["a.txt", "b.txt"]);
});

test("state ownership: another workspace's baseline reads as fresh; same workspace kept; legacy unstamped adopted", async () => {
  const remote = new FakeRemote();
  await write("a.txt", "aaa\n");
  await push(root, cfg, deps(remote)); // stamps workspaceId: ws_t at seq 1

  expect((await loadState(root, syncStreamId(cfg))).lastSyncedSequence).toBe(1); // kept
  const foreign = await loadState(root, syncStreamId({ ...cfg, remoteWorkspaceId: "ws_other" })); // mismatch → no baseline
  expect(foreign.lastSyncedSequence).toBe(0);
  expect(foreign.lastSyncedManifest.files).toHaveLength(0);

  // Legacy state file written before the stamp existed: adopted as-is.
  const statePath = path.join(root, ".rbox", "state.json");
  const legacy = JSON.parse(await fs.readFile(statePath, "utf8"));
  delete legacy.stream;
  await fs.writeFile(statePath, JSON.stringify(legacy));
  expect((await loadState(root, syncStreamId(cfg))).lastSyncedSequence).toBe(1);
  expect((await loadState(root, syncStreamId(cfg))).stream).toBe(syncStreamId(cfg));
});

test("mass-delete guard: a pull deleting ≥half the baseline fails closed until --allow-mass-delete", async () => {
  const remote = new FakeRemote();
  for (let i = 0; i < 120; i++) await write(`f${i}.txt`, `${i}\n`);
  await push(root, cfg, deps(remote)); // baseline: 120 files

  remote.injectCommit([]); // the remote head becomes EMPTY (poisoned/reset stream)
  await expect(pull(root, cfg, deps(remote))).rejects.toThrow(/mass-delete guard/);
  expect(await read("f0.txt")).toBe("0\n"); // fails closed BEFORE touching disk
  expect(await read("f119.txt")).toBe("119\n");

  // Explicit consent applies the deletion wave once.
  await pull(root, cfg, { ...deps(remote), allowMassDelete: true });
  await expect(fs.access(path.join(root, "f0.txt"))).rejects.toThrow();
});

test("mass-delete guard: normal-scale deletions (under half the baseline) apply without consent", async () => {
  const remote = new FakeRemote();
  for (let i = 0; i < 120; i++) await write(`f${i}.txt`, `${i}\n`);
  await push(root, cfg, deps(remote));

  // Remote deletes 30 of 120 (a big-but-legit cleanup): survives the guard.
  const head = (await remote.latest()).manifest;
  remote.injectCommit(head.files.filter((f) => Number(f.path.slice(1, -4)) < 90));
  const actions = await pull(root, cfg, deps(remote));
  expect(actions.filter((a) => a.kind === "delete")).toHaveLength(30);
  await expect(fs.access(path.join(root, "f90.txt"))).rejects.toThrow();
  expect(await read("f89.txt")).toBe("89\n");
});

test("push reports committed=false on a no-op (the setup flow must never claim a publish that didn't happen)", async () => {
  const remote = new FakeRemote();
  await write("x.txt", "x\n");
  const first = await push(root, cfg, deps(remote));
  expect(first.committed).toBe(true);
  const second = await push(root, cfg, deps(remote)); // nothing changed
  expect(second.committed).toBe(false);
  expect(second.sequence).toBe(first.sequence);
});
