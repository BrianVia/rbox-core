import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyActions,
  buildIgnoreMatcher,
  DirCache,
  hashBytes,
  HashCache,
  oracleFromPull,
  oracleFromState,
  RACY_MARGIN_MS,
  scanManifest,
  type Action,
  type BlobStore,
  type FileEntry,
  type IgnoreMatcher,
  type Manifest,
} from "./index.js";
import { CONFLICT_COPY_POPULATION_WHY, type OracleVerdict } from "./apply-receipt.js";

const roots: string[] = [];
const blocked: string[] = [];

afterEach(async () => {
  for (const target of blocked.splice(0)) await fs.chmod(target, 0o700).catch(() => undefined);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-apply-receipt-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "repo"), { recursive: true });
  return root;
}

const manifest = (files: FileEntry[], generatedAt = "2026-01-01T00:00:00.000Z"): Manifest => ({ generatedAt, files });

function fileEntry(rel: string, text: string, mode = 0o644): FileEntry {
  const bytes = Buffer.from(text);
  return { path: rel, type: "file", sha256: hashBytes(bytes), size: bytes.length, mode, mtimeMs: 1 };
}

const storeFor = (values: Record<string, string>): BlobStore => {
  const blobs = new Map(Object.values(values).map((text) => [hashBytes(Buffer.from(text)), Buffer.from(text)]));
  return {
    async has(sha) { return blobs.has(sha); },
    async put(sha, bytes) { blobs.set(sha, Buffer.from(bytes)); },
    async get(sha) {
      const value = blobs.get(sha);
      if (!value) throw new Error("missing test blob");
      return value;
    },
  };
};

async function scanFixture(root: string, matcher: IgnoreMatcher = buildIgnoreMatcher(root)) {
  const hashcache = new HashCache();
  const dircache = new DirCache();
  const deferred = new Set<string>();
  const preScan = await scanManifest(root, matcher, hashcache, undefined, undefined, undefined, deferred, undefined, dircache, "unpruned");
  return { preScan, matcher, hashcache, dircache, deferred };
}

function pullOracle(root: string, fixture: Awaited<ReturnType<typeof scanFixture>>, actions: Action[] = [], truth = fixture.preScan, scanDeferred = fixture.deferred) {
  return oracleFromPull({ preScan: fixture.preScan, actions, oracle: truth, matcher: fixture.matcher, dircache: fixture.dircache, hashcache: fixture.hashcache, root, scanDeferred });
}

const runningAsRoot = (): boolean => process.getuid?.() === 0;

function expectNotMatch(verdict: OracleVerdict): void {
  expect(verdict.kind).not.toBe("match");
}

async function git(root: string, args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" } });
  const code = await child.exited;
  if (code !== 0) throw new Error(await new Response(child.stderr).text());
}

test("sync-applied bytes match the oracle even while dirty against old HEAD", async () => {
  const root = await tmp();
  await fs.writeFile(path.join(root, "repo/tracked.txt"), "old");
  await git(path.join(root, "repo"), ["init", "-q"]);
  await git(path.join(root, "repo"), ["add", "tracked.txt"]);
  await git(path.join(root, "repo"), ["commit", "-qm", "old"]);
  const fixture = await scanFixture(root);
  const remote = fileEntry("repo/tracked.txt", "new");
  const action: Action = { kind: "write", entry: remote, expectedLocal: fixture.preScan.files.find((entry) => entry.path === remote.path) };
  await applyActions(root, [action], storeFor({ remote: "new" }));

  expect((await pullOracle(root, fixture, [action], manifest([remote])).proveRepo("repo")).kind).toBe("match");
});

test("oracle construction does not iterate manifests or create dircache state", async () => {
  const root = await tmp();
  let iterations = 0;
  const files = new Proxy<FileEntry[]>([], {
    get(target, property, receiver) {
      if (property === Symbol.iterator) iterations++;
      return Reflect.get(target, property, receiver);
    },
  });
  const mkdir = spyOn(fs, "mkdir");
  try {
    oracleFromPull({
      preScan: manifest(files),
      actions: [],
      oracle: manifest(files),
      matcher: buildIgnoreMatcher(root),
      dircache: new DirCache(),
      root,
      scanDeferred: new Set(),
    });
    expect(iterations).toBe(0);
    expect(mkdir).toHaveBeenCalledTimes(0);
  } finally {
    mkdir.mockRestore();
  }
});

test("pull oracle observer attributes lazy preparation, receipt hashing, and every proof", async () => {
  const root = await tmp();
  await fs.writeFile(path.join(root, "repo/a.txt"), "a");
  const fixture = await scanFixture(root);
  const observations: Array<{ kind: string; ms?: number; entriesIndexed?: number }> = [];
  const oracle = oracleFromPull({
    preScan: fixture.preScan,
    actions: [],
    oracle: fixture.preScan,
    matcher: fixture.matcher,
    dircache: fixture.dircache,
    hashcache: fixture.hashcache,
    root,
    scanDeferred: fixture.deferred,
    observer: (observation) => observations.push(observation),
  });

  expect(observations).toEqual([]);
  expect((await oracle.proveRepo("repo")).kind).toBe("match");
  expect((await oracle.reproveRepo("repo")).kind).toBe("match");
  expect(observations.filter((observation) => observation.kind === "prepare")).toHaveLength(1);
  expect(observations.find((observation) => observation.kind === "prepare")).toMatchObject({ entriesIndexed: 3 });
  expect(observations.filter((observation) => observation.kind === "receipt-hash")).toHaveLength(1);
  expect(observations.filter((observation) => observation.kind === "repo-proved")).toHaveLength(2);
  expect(observations.every((observation) => observation.ms === undefined || observation.ms >= 0)).toBe(true);
});

test("action-touched same-size mtime-restored edits are content-hashed", async () => {
  const root = await tmp();
  const abs = path.join(root, "repo/file.txt");
  await fs.writeFile(abs, "old!");
  const stableTime = Math.floor(Date.now() / 1000) - 10;
  await fs.utimes(abs, stableTime, stableTime);
  const fixture = await scanFixture(root);
  const remote = fileEntry("repo/file.txt", "aaaa");
  const action: Action = { kind: "write", entry: remote, expectedLocal: fixture.preScan.files[0] };
  await applyActions(root, [action], storeFor({ remote: "aaaa" }));
  await fs.utimes(abs, stableTime, stableTime);
  const appliedMtime = (await fs.lstat(abs)).mtimeMs;

  await fs.writeFile(abs, "bbbb");
  await fs.utimes(abs, new Date(appliedMtime), new Date(appliedMtime));
  expect((await fs.lstat(abs)).mtimeMs).toBe(appliedMtime);
  expect((await pullOracle(root, fixture, [action], manifest([remote])).proveRepo("repo")).kind).toBe("mismatch");
});

test("untouched-entry token trust includes cached ctime and re-hashes on movement", async () => {
  const root = await tmp();
  const abs = path.join(root, "repo/file.txt");
  await fs.writeFile(abs, "aaaa");
  const stableTime = Math.floor(Date.now() / 1000) - 10;
  await fs.utimes(abs, stableTime, stableTime);
  const fixture = await scanFixture(root);
  const before = fixture.preScan.files.find((entry) => entry.path === "repo/file.txt")!;

  expect((await pullOracle(root, fixture).proveRepo("repo")).kind).toBe("match");

  await fs.writeFile(abs, "bbbb");
  await fs.utimes(abs, new Date(before.mtimeMs), new Date(before.mtimeMs));
  expect((await fs.lstat(abs)).mtimeMs).toBe(before.mtimeMs);
  expect((await pullOracle(root, fixture).proveRepo("repo")).kind).toBe("mismatch");

  await fs.writeFile(abs, "different-size");
  expect((await pullOracle(root, fixture).proveRepo("repo")).kind).toBe("mismatch");
});

test("post-scan create, delete, and rename never return match", async () => {
  for (const mutate of [
    async (root: string) => fs.writeFile(path.join(root, "repo/extra.txt"), "extra"),
    async (root: string) => fs.unlink(path.join(root, "repo/a.txt")),
    async (root: string) => fs.rename(path.join(root, "repo/a.txt"), path.join(root, "repo/renamed.txt")),
  ]) {
    const root = await tmp();
    await fs.writeFile(path.join(root, "repo/a.txt"), "a");
    const fixture = await scanFixture(root);
    await mutate(root);
    expectNotMatch(await pullOracle(root, fixture).proveRepo("repo"));
  }
});

test("unignored extras mismatch while ignored and rbox/git-internal bytes remain untouched", async () => {
  const root = await tmp();
  await fs.writeFile(path.join(root, ".rboxignore"), "repo/*.tmp\n");
  await fs.writeFile(path.join(root, "repo/a.txt"), "a");
  const matcher = buildIgnoreMatcher(root);
  const fixture = await scanFixture(root, matcher);
  await fs.writeFile(path.join(root, "repo/human.tmp"), "precious");
  await fs.mkdir(path.join(root, "repo/.git"));
  await fs.writeFile(path.join(root, "repo/.git/local"), "metadata");
  await fs.mkdir(path.join(root, ".rbox/state"), { recursive: true });
  await fs.writeFile(path.join(root, ".rbox/state/local"), "state");
  const oracle = pullOracle(root, fixture);
  expect((await oracle.proveRepo("repo")).kind).toBe("match");
  expect(await fs.readFile(path.join(root, "repo/human.tmp"), "utf8")).toBe("precious");
  expect(await fs.readFile(path.join(root, "repo/.git/local"), "utf8")).toBe("metadata");

  await fs.writeFile(path.join(root, "repo/extra.txt"), "extra");
  expect((await pullOracle(root, fixture).proveRepo("repo")).kind).toBe("mismatch");
});

test("symlink target, executable bit, and file/symlink type flips mismatch", async () => {
  {
    const root = await tmp();
    await fs.symlink("one", path.join(root, "repo/link"));
    const fixture = await scanFixture(root);
    await fs.unlink(path.join(root, "repo/link"));
    await fs.symlink("two", path.join(root, "repo/link"));
    expect((await pullOracle(root, fixture).proveRepo("repo")).kind).toBe("mismatch");
  }
  {
    const root = await tmp();
    await fs.writeFile(path.join(root, "repo/run"), "run");
    await fs.chmod(path.join(root, "repo/run"), 0o644);
    const fixture = await scanFixture(root);
    await fs.chmod(path.join(root, "repo/run"), 0o755);
    expect((await pullOracle(root, fixture).proveRepo("repo")).kind).toBe("mismatch");
  }
  for (const startAsLink of [false, true]) {
    const root = await tmp();
    const abs = path.join(root, "repo/item");
    if (startAsLink) await fs.symlink("target", abs); else await fs.writeFile(abs, "target");
    const fixture = await scanFixture(root);
    await fs.unlink(abs);
    if (startAsLink) await fs.writeFile(abs, "target"); else await fs.symlink("target", abs);
    expect((await pullOracle(root, fixture).proveRepo("repo")).kind).toBe("mismatch");
  }
});

test("scan-deferred paths intersecting only this projection are indeterminate", async () => {
  const root = await tmp();
  await fs.writeFile(path.join(root, "repo/a"), "a");
  await fs.mkdir(path.join(root, "other"));
  await fs.writeFile(path.join(root, "other/b"), "b");
  const fixture = await scanFixture(root);
  expect((await pullOracle(root, fixture, [], fixture.preScan, new Set(["repo/a"])).proveRepo("repo")).kind).toBe("indeterminate");
  expect((await pullOracle(root, fixture, [], fixture.preScan, new Set(["other/b"])).proveRepo("repo")).kind).toBe("match");
});

test("a real unreadable state file is indeterminate even with a matching hash cache token", async () => {
  if (runningAsRoot()) return;
  const root = await tmp();
  const secret = path.join(root, "repo/secret");
  await fs.writeFile(secret, "secret");
  const cache = new HashCache();
  const base = await scanManifest(root, undefined, cache);
  await cache.save(root);
  await fs.chmod(secret, 0o000);
  blocked.push(secret);
  expect((await oracleFromState({ base, matcher: buildIgnoreMatcher(root), root }).proveRepo("repo")).kind).toBe("indeterminate");
});

test("conflict action proves its kept-local extra and therefore mismatches remote truth", async () => {
  const root = await tmp();
  await fs.writeFile(path.join(root, "repo/file.txt"), "local");
  const fixture = await scanFixture(root);
  const remote = fileEntry("repo/file.txt", "remote");
  const action: Action = { kind: "conflict", path: remote.path, keepLocalAs: "repo/file.local.conflict.txt", entry: remote };
  await applyActions(root, [action], storeFor({ remote: "remote" }));
  expect((await pullOracle(root, fixture, [action], manifest([remote])).proveRepo("repo")).kind).toBe("mismatch");
  expect(await fs.readFile(path.join(root, action.keepLocalAs), "utf8")).toBe("local");
});

test("nested dirt blocks its parent; parent-only dirt does not block the child", async () => {
  {
    const root = await tmp();
    await fs.mkdir(path.join(root, "repo/child"));
    await fs.writeFile(path.join(root, "repo/parent.txt"), "parent");
    await fs.writeFile(path.join(root, "repo/child/child.txt"), "child");
    const fixture = await scanFixture(root);
    await fs.writeFile(path.join(root, "repo/child/child.txt"), "dirty-child");
    expect((await pullOracle(root, fixture).proveRepo("repo")).kind).toBe("mismatch");
    expect((await pullOracle(root, fixture).proveRepo("repo/child")).kind).toBe("mismatch");
  }
  {
    const root = await tmp();
    await fs.mkdir(path.join(root, "repo/child"));
    await fs.writeFile(path.join(root, "repo/parent.txt"), "parent");
    await fs.writeFile(path.join(root, "repo/child/child.txt"), "child");
    const fixture = await scanFixture(root);
    await fs.writeFile(path.join(root, "repo/parent.txt"), "dirty-parent");
    const oracle = pullOracle(root, fixture);
    expect((await oracle.proveRepo("repo")).kind).toBe("mismatch");
    expect((await oracle.proveRepo("repo/child")).kind).toBe("match");
  }
});

test("reprove is token-only when stable and widens only to the repo subtree on movement", async () => {
  const root = await tmp();
  await fs.writeFile(path.join(root, "repo/file.txt"), "same");
  await fs.mkdir(path.join(root, "outside"));
  await fs.writeFile(path.join(root, "outside/trap"), "trap");
  const fixture = await scanFixture(root);
  const oracle = pullOracle(root, fixture);
  expect((await oracle.proveRepo("repo")).kind).toBe("match");

  const readdir = spyOn(fs, "readdir");
  const loadHashCache = spyOn(HashCache, "load");
  try {
    expect((await oracle.reproveRepo("repo")).kind).toBe("match");
    expect(readdir).toHaveBeenCalledTimes(0);
    expect(loadHashCache).toHaveBeenCalledTimes(0);

    const abs = path.join(root, "repo/file.txt");
    const now = Date.now() / 1000 + 10;
    await fs.utimes(abs, now, now);
    expect((await oracle.reproveRepo("repo")).kind).toBe("match");
    expect(readdir.mock.calls.length).toBeGreaterThan(0);
    expect(readdir.mock.calls.every(([seen]) => String(seen).startsWith(path.join(root, "repo")))).toBeTrue();

    await fs.writeFile(abs, "dirt");
    expect((await oracle.reproveRepo("repo")).kind).toBe("mismatch");
  } finally {
    loadHashCache.mockRestore();
    readdir.mockRestore();
  }
});

test("proveRepo uses a fresh real dircache inventory without readdir", async () => {
  const root = await tmp();
  await fs.writeFile(path.join(root, "repo/file"), "stable");
  const fixture = await scanFixture(root);
  // Model a settled cache: every cached directory token is now strictly older
  // than the caching scan's racy-clean cutoff.
  fixture.dircache.setLastScanStartMs(Date.now() + RACY_MARGIN_MS + 100);
  const readdir = spyOn(fs, "readdir");
  try {
    expect((await pullOracle(root, fixture).proveRepo("repo")).kind).toBe("match");
    expect(readdir).toHaveBeenCalledTimes(0);
  } finally {
    readdir.mockRestore();
  }
});

test("oracleFromState scans only the requested subtree and hashes observed mismatch receipts", async () => {
  const root = await tmp();
  await fs.writeFile(path.join(root, "repo/file"), "base");
  await fs.mkdir(path.join(root, "outside"));
  await fs.writeFile(path.join(root, "outside/trap"), "trap");
  const base = await scanManifest(root);
  const outside = path.join(root, "outside");
  if (!runningAsRoot()) {
    await fs.chmod(outside, 0o000);
    blocked.push(outside);
  }
  const oracle = oracleFromState({ base, matcher: buildIgnoreMatcher(root), root });
  expect((await oracle.proveRepo("repo")).kind).toBe("match");

  await fs.writeFile(path.join(root, "repo/file"), "dirt-one");
  expect((await oracle.proveRepo("repo")).kind).toBe("mismatch");
  const first = oracle.receiptHash("repo");
  expect(first).toBeDefined();
  await fs.writeFile(path.join(root, "repo/file"), "dirt-two");
  expect((await oracle.proveRepo("repo")).kind).toBe("mismatch");
  expect(oracle.receiptHash("repo")).not.toBe(first);
});

test("unsupported special entries are indeterminate even through dircache inventory", async () => {
  const root = await tmp();
  const fifo = path.join(root, "repo/fifo");
  const child = Bun.spawn(["mkfifo", fifo], { stdout: "ignore", stderr: "pipe" });
  if (await child.exited !== 0) return;
  const fixture = await scanFixture(root);
  fixture.dircache.setLastScanStartMs(Date.now() + RACY_MARGIN_MS + 100);
  const readdir = spyOn(fs, "readdir");
  try {
    expect((await pullOracle(root, fixture).proveRepo("repo")).kind).toBe("indeterminate");
    expect(readdir).toHaveBeenCalledTimes(0);
  } finally {
    readdir.mockRestore();
  }
});

test("ignored special entries are removed symmetrically", async () => {
  const root = await tmp();
  await fs.writeFile(path.join(root, ".rboxignore"), "repo/ignored-fifo\n");
  const fixture = await scanFixture(root, buildIgnoreMatcher(root));
  const child = Bun.spawn(["mkfifo", path.join(root, "repo/ignored-fifo")], { stdout: "ignore", stderr: "pipe" });
  if (await child.exited !== 0) return;
  expect((await pullOracle(root, fixture).proveRepo("repo")).kind).toBe("match");
});

async function aliases(root: string, first: string, second: string): Promise<boolean> {
  const dir = path.join(root, "alias-probe");
  await fs.mkdir(dir);
  const a = path.join(dir, first);
  const b = path.join(dir, second);
  await fs.writeFile(a, "x");
  try {
    const [sa, sb] = await Promise.all([fs.lstat(a), fs.lstat(b)]);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("receiver-equivalent spellings require one identity and oracle collisions are indeterminate", async () => {
  const root = await tmp();
  const caseAliases = await aliases(root, "Case", "case");
  const unicodeAliases = await aliases(root, "é", "e\u0301");
  const variants: Array<[string, string]> = [];
  if (caseAliases) variants.push(["Case.txt", "case.txt"]);
  if (unicodeAliases) variants.push(["é.txt", "e\u0301.txt"]);
  for (const [diskName, aliasName] of variants) {
    await fs.writeFile(path.join(root, "repo", diskName), "same");
    const fixture = await scanFixture(root);
    const disk = fixture.preScan.files.find((entry) => entry.path === `repo/${diskName}`)!;
    const alias = { ...disk, path: `repo/${aliasName}` };
    expect((await pullOracle(root, fixture, [], manifest([alias])).proveRepo("repo")).kind).toBe("match");
    expect((await pullOracle(root, fixture, [], manifest([disk, alias])).proveRepo("repo")).kind).toBe("indeterminate");
    await fs.rm(path.join(root, "repo", diskName));
  }

  if (!caseAliases && !unicodeAliases) {
    await fs.writeFile(path.join(root, "repo/Case.txt"), "same");
    const fixture = await scanFixture(root);
    const disk = fixture.preScan.files.find((entry) => entry.path === "repo/Case.txt")!;
    expect((await pullOracle(root, fixture, [], manifest([{ ...disk, path: "repo/case.txt" }])).proveRepo("repo")).kind).toBe("mismatch");
  }
});

const CTS = "20260816041610";
const stateOracle = (root: string, base: Manifest) => oracleFromState({ base, matcher: buildIgnoreMatcher(root), root });

test("a conflict copy below the repo root drops from BOTH the manifest side and the walk side", async () => {
  const root = await tmp();
  await fs.writeFile(path.join(root, "repo/tracked.txt"), "keep");
  await fs.writeFile(path.join(root, `repo/tracked.dev_x.${CTS}.conflict.txt`), "minted");
  const fixture = await scanFixture(root);
  const tracked = fixture.preScan.files.find((entry) => entry.path === "repo/tracked.txt")!;
  const copy = fixture.preScan.files.find((entry) => entry.path === `repo/tracked.dev_x.${CTS}.conflict.txt`)!;

  // walk side: on disk, absent from the applied manifest — today's #659 extra.
  expect((await pullOracle(root, fixture, [], manifest([tracked])).proveRepo("repo")).kind).toBe("match");
  expect((await stateOracle(root, manifest([tracked])).proveRepo("repo")).kind).toBe("match");
  // manifest side: in the applied manifest, removed from disk.
  await fs.rm(path.join(root, `repo/tracked.dev_x.${CTS}.conflict.txt`));
  expect((await stateOracle(root, manifest([tracked, copy])).proveRepo("repo")).kind).toBe("match");
});

test("a conflict-named directory INSIDE a repo prunes its whole subtree", async () => {
  const root = await tmp();
  await fs.writeFile(path.join(root, "repo/tracked.txt"), "keep");
  await fs.mkdir(path.join(root, `repo/evicted.dev_x.${CTS}.conflict`), { recursive: true });
  await fs.writeFile(path.join(root, `repo/evicted.dev_x.${CTS}.conflict/inner.txt`), "inner");
  const fixture = await scanFixture(root);
  const tracked = fixture.preScan.files.find((entry) => entry.path === "repo/tracked.txt")!;

  expect((await pullOracle(root, fixture, [], manifest([tracked])).proveRepo("repo")).kind).toBe("match");
  expect((await stateOracle(root, manifest([tracked])).proveRepo("repo")).kind).toBe("match");
});

test("a repo addressed BY a conflict-named root or ancestor still compares its contents", async () => {
  for (const rel of [`r.dev_x.${CTS}.conflict`, `anc.dev_x.${CTS}.conflict/r`]) {
    const root = await tmp();
    await fs.mkdir(path.join(root, rel), { recursive: true });
    await fs.writeFile(path.join(root, rel, "tracked.txt"), "old");
    const fixture = await scanFixture(root);
    const tracked = fixture.preScan.files.find((entry) => entry.path === `${rel}/tracked.txt`)!;
    await fs.writeFile(path.join(root, rel, "tracked.txt"), "diverged from the applied manifest");

    // `mismatch` positively, never `indeterminate`: an "at or below" regression
    // empties both populations, arms the guard, and would satisfy "not match".
    expect((await pullOracle(root, fixture, [], manifest([tracked])).proveRepo(rel)).kind).toBe("mismatch");
    expect((await stateOracle(root, manifest([tracked])).proveRepo(rel)).kind).toBe("mismatch");
  }
});

test("a population the conflict grammar emptied is indeterminate, not a vacuous match", async () => {
  const root = await tmp();
  await fs.mkdir(path.join(root, `repo/only.dev_x.${CTS}.conflict`), { recursive: true });
  await fs.writeFile(path.join(root, `repo/only.dev_x.${CTS}.conflict/a.txt`), "a");
  const fixture = await scanFixture(root);
  const copy = fixture.preScan.files.find((entry) => entry.path === `repo/only.dev_x.${CTS}.conflict/a.txt`)!;

  // :541 — manifest x manifest, through the pull oracle.
  const pull = await pullOracle(root, fixture, [], manifest([copy])).proveRepo("repo");
  expect(pull).toEqual({ kind: "indeterminate", why: CONFLICT_COPY_POPULATION_WHY });
  // :669 — disk x manifest, through the state oracle.
  const state = await stateOracle(root, manifest([copy])).proveRepo("repo");
  expect(state).toEqual({ kind: "indeterminate", why: CONFLICT_COPY_POPULATION_WHY });
});

test("a genuinely empty repo still matches — the guard is the grammar, never an empty population", async () => {
  const root = await tmp();
  await git(path.join(root, "repo"), ["init", "-q"]);
  const fixture = await scanFixture(root);

  expect((await pullOracle(root, fixture, [], manifest([])).proveRepo("repo")).kind).toBe("match");
  expect((await stateOracle(root, manifest([])).proveRepo("repo")).kind).toBe("match");
});

test("an entry the matcher already ignores never arms the guard, whatever it is named", async () => {
  const root = await tmp();
  await fs.writeFile(path.join(root, `repo/only.dev_x.${CTS}.conflict.log`), "minted");
  // A user rule as ordinary as `*.conflict*` covers rbox's own mint grammar. If
  // the grammar arm ran first, that rule would make every repo it empties
  // permanently indeterminate — the entry was never comparable to begin with.
  const matcher = buildIgnoreMatcher(root, ["*.conflict*"]);
  const fixture = await scanFixture(root, matcher);
  expect(fixture.preScan.files).toEqual([]);

  expect(await pullOracle(root, fixture, [], manifest([])).proveRepo("repo")).toEqual({ kind: "match" });
  expect(await oracleFromState({ base: manifest([]), matcher, root }).proveRepo("repo")).toEqual({ kind: "match" });
});

test("the pull that deletes the LAST conflict copy settles in that same cycle", async () => {
  const root = await tmp();
  const copyRel = `repo/only.dev_x.${CTS}.conflict.txt`;
  await fs.writeFile(path.join(root, copyRel), "minted");
  const fixture = await scanFixture(root);
  const copy = fixture.preScan.files.find((entry) => entry.path === copyRel)!;
  await fs.rm(path.join(root, copyRel));

  // `preScan` is the stat/hash fast-path source, not a comparison population:
  // arming on it would hold the repo for a cycle, telling the user to delete
  // files this very pull already removed.
  const actions: Action[] = [{ kind: "delete", path: copyRel, expectedLocal: copy }];
  expect(await pullOracle(root, fixture, actions, manifest([])).proveRepo("repo")).toEqual({ kind: "match" });
});

test("a downgraded prove mints no receipt credential and its hold survives the next boundary", async () => {
  const root = await tmp();
  await fs.mkdir(path.join(root, `repo/only.dev_x.${CTS}.conflict`), { recursive: true });
  await fs.writeFile(path.join(root, `repo/only.dev_x.${CTS}.conflict/a.txt`), "a");
  const fixture = await scanFixture(root);
  const copy = fixture.preScan.files.find((entry) => entry.path === `repo/only.dev_x.${CTS}.conflict/a.txt`)!;
  const oracle = pullOracle(root, fixture, [], manifest([copy]));

  expect((await oracle.proveRepo("repo")).kind).toBe("indeterminate");
  expect(oracle.receiptHash("repo")).toBeUndefined();
  expect(await oracle.reproveRepo("repo")).toEqual({ kind: "indeterminate", why: CONFLICT_COPY_POPULATION_WHY });
});

test("a conflict-grammar special file stays fail-closed on BOTH walks", async () => {
  const root = await tmp();
  await fs.writeFile(path.join(root, "repo/tracked.txt"), "keep");
  const fixture = await scanFixture(root);
  const tracked = fixture.preScan.files.find((entry) => entry.path === "repo/tracked.txt")!;
  const fifo = Bun.spawn(["mkfifo", path.join(root, `repo/pipe.dev_x.${CTS}.conflict`)], { stdout: "ignore", stderr: "pipe" });
  if (await fifo.exited !== 0) return;

  // A surviving comparable pair keeps the population non-empty, so only the
  // `unsupported-entry` throw can produce this why.
  const unsupported = { kind: "indeterminate", why: "unsupported entry type in repo subtree" };
  expect(await pullOracle(root, fixture, [], manifest([tracked])).proveRepo("repo")).toEqual(unsupported);
  expect(await stateOracle(root, manifest([tracked])).proveRepo("repo")).toEqual(unsupported);
});
