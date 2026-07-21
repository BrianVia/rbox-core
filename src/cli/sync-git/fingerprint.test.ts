import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildIgnoreMatcher, gitPreflight, hashBytes } from "../../engine/index.js";
import {
  MAX_GIT_CONFIG_KEYS,
  MAX_GIT_CONFIG_KEY_BYTES,
  MAX_GIT_CONFIG_SERIALIZED_BYTES,
  MAX_GIT_CONFIG_VALUE_BYTES,
} from "../../engine/git/config-sync.js";
import { gitDivergenceFastRepoSource } from "./divergence-cache.js";
import { gitFingerprint, gitFingerprintRun } from "./fingerprint.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-git-fp-"));
  roots.push(root);
  return root;
}

test("packed-refs.lock participates in fingerprint invalidation", async () => {
  const root = await tempRoot();
  await exec("git", ["-C", root, "init", "-q"]);
  const before = await gitFingerprint(gitFingerprintRun("per-decision"), root, ".");
  await fs.writeFile(path.join(root, ".git", "packed-refs.lock"), "transaction");
  const during = await gitFingerprint(gitFingerprintRun("per-decision"), root, ".");
  expect(during.hash).not.toBe(before.hash);
});

test("schema-4 trusted preflight cache is invalidated before config-authoritative reftable refusal", async () => {
  const root = await tempRoot();
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  await exec("git", ["-C", repo, "init", "--ref-format=reftable", "-q"]);
  const fingerprint = await gitFingerprint(gitFingerprintRun("per-decision"), root, "repo");
  const oldVersion = hashBytes(Buffer.from(JSON.stringify({
    schema: 4,
    configWireBounds: [MAX_GIT_CONFIG_KEYS, MAX_GIT_CONFIG_SERIALIZED_BYTES, MAX_GIT_CONFIG_KEY_BYTES, MAX_GIT_CONFIG_VALUE_BYTES],
  })));
  const cachePath = path.join(root, ".rbox", "state", "git-divergence.json");
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify({
    version: oldVersion,
    repos: {
      repo: {
        fingerprint: fingerprint.hash,
        writtenAtMs: Date.now() + 60_000,
        identityKey: "trusted-old-reftable",
        kind: "dir",
        probe: { busy: false, preflightOk: true, preflightKind: "dir", identityKey: "trusted-old-reftable" },
      },
    },
  }));

  expect(await gitDivergenceFastRepoSource(root, undefined, buildIgnoreMatcher(root))).toEqual([]);
  expect(await gitPreflight(repo)).toEqual(expect.objectContaining({ ok: false, structural: true, reason: expect.stringMatching(/reftable/i) }));
});

test("split-index shared dependency invalidates while the link index stays byte-identical", async () => {
  const root = await tempRoot();
  await exec("git", ["-C", root, "init", "-q"]);
  await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", root, "config", "user.name", "Test"]);
  await fs.writeFile(path.join(root, "tracked"), "one\n");
  await exec("git", ["-C", root, "add", "tracked"]);
  await exec("git", ["-C", root, "commit", "-qm", "one"]);
  await exec("git", ["-C", root, "update-index", "--split-index"]);

  const sharedRel = (await exec("git", ["-C", root, "rev-parse", "--shared-index-path"])).stdout.trim();
  const shared = path.resolve(root, sharedRel);
  const linkBefore = await fs.readFile(path.join(root, ".git", "index"));
  const before = await gitFingerprint(gitFingerprintRun("per-decision"), root, ".", { includeIndexDependencies: true });
  expect(before.dependenciesComplete).toBe(true);

  const bytes = await fs.readFile(shared);
  bytes[Math.max(0, bytes.length - 1)] ^= 1;
  await fs.writeFile(shared, bytes);

  const after = await gitFingerprint(gitFingerprintRun("per-decision"), root, ".", { includeIndexDependencies: true });
  expect(await fs.readFile(path.join(root, ".git", "index"))).toEqual(linkBefore);
  expect(after.hash).not.toBe(before.hash);
});
