import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CORPUS_112K_SEED,
  CORPUS_CONTRACT_MANIFEST_SHA256,
  SHAPES,
  computeCorpusManifestHash,
  generateCorpus,
} from "./corpus";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-corpus-contract-"));
  roots.push(root);
  return root;
}

test("same seed produces the pinned byte-identical feature-complete corpus", () => {
  const first = tempRoot();
  const second = tempRoot();
  const shape = SHAPES["corpus-contract"]!;

  const firstStats = generateCorpus(first, shape, CORPUS_112K_SEED);
  const secondStats = generateCorpus(second, shape, CORPUS_112K_SEED);
  const firstHash = computeCorpusManifestHash(first);

  expect(firstStats.files).toBe(shape.files);
  expect(secondStats).toEqual(firstStats);
  expect(firstHash).toBe(CORPUS_CONTRACT_MANIFEST_SHA256);
  expect(computeCorpusManifestHash(second)).toBe(firstHash);
  expect(fs.readFileSync(path.join(first, "repos/repo-00/.git/HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
  expect(fs.statSync(path.join(first, "repos/repo-00/.git/objects")).isDirectory()).toBe(true);
  expect(fs.readFileSync(path.join(first, "repos/repo-00/src/ignored-shape-0/.gitignore"), "utf8"))
    .toContain("!important.cache");
  expect(fs.existsSync(path.join(first, "repos/repo-00/src/ignored-shape-0/generated/output.js"))).toBe(true);
  expect(fs.existsSync(path.join(first, "repos/repo-00/src/ignored-shape-0/important.cache"))).toBe(true);
});

test("a different seed changes corpus identity without changing shape", () => {
  const first = tempRoot();
  const second = tempRoot();
  const shape = SHAPES["corpus-contract"]!;

  const firstStats = generateCorpus(first, shape, CORPUS_112K_SEED);
  const secondStats = generateCorpus(second, shape, CORPUS_112K_SEED + 1);

  expect(secondStats.files).toBe(firstStats.files);
  expect(secondStats.emptyFiles).toBe(firstStats.emptyFiles);
  expect(secondStats.duplicateFiles).toBe(firstStats.duplicateFiles);
  expect(computeCorpusManifestHash(second)).not.toBe(computeCorpusManifestHash(first));
});
