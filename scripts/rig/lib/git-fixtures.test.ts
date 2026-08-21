import { afterAll, describe, expect, test } from "bun:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitPreflight } from "../../../src/cli/sync-git/preflight.js";
import { validateManifest } from "../../../src/engine/manifest-validate.js";
import { OP_STATE_DIRS, OP_STATE_FILES } from "../../../src/engine/manifest-validate.js";
import { formatGitPushLine, type GitPushPlan } from "../../../src/cli/sync-git/plan.js";
import {
  GIT_FIXTURE_BUILDERS,
  GIT_LAYOUT_CELLS,
  GIT_LAYOUT_OUTCOMES,
  GIT_LAYOUT_OP_STATE_ROOTS,
  GIT_LAYOUT_REFUSALS,
  LFS_PAYLOAD,
  NFC_FILENAME,
  NFC_FILENAME_HEX,
  NFD_FILENAME,
  NFD_FILENAME_HEX,
  buildS1InitializedSubmodule,
  buildS3CaseCollision,
  buildS4Shallow,
  formatFixturePlanLine,
  type GitFixtureDescription,
} from "./git-fixtures.js";

const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function executeDescription(description: GitFixtureDescription): Promise<{ root: string; aux: string }> {
  const base = await mkdtemp(path.join(tmpdir(), `rbox-${description.cell}-`));
  scratch.push(base);
  const root = path.join(base, "root");
  const aux = path.join(base, "aux");
  await Bun.$`mkdir -p ${root} ${aux}`.quiet();
  for (const command of description.commands) {
    const proc = Bun.spawnSync([...command.argv], {
      env: { ...process.env, FIXTURE_ROOT: root, FIXTURE_AUX: aux, ...(command.env ?? {}) },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      throw new Error(`${description.cell} fixture failed: ${proc.stderr.toString()}`);
    }
  }
  return { root, aux };
}

describe("git fixture descriptions", () => {
  test("enumerate fourteen builders and all fifteen normative outcomes", () => {
    expect(GIT_LAYOUT_CELLS).toHaveLength(14);
    expect(GIT_LAYOUT_OUTCOMES).toHaveLength(15);
    expect(new Set(GIT_LAYOUT_OUTCOMES).size).toBe(15);
    expect(GIT_LAYOUT_OUTCOMES).toContain("s1-a/mod");
  });

  test("are pure and deterministic", () => {
    for (const [cell, builder] of Object.entries(GIT_FIXTURE_BUILDERS)) {
      expect(builder()).toEqual(builder());
      expect(builder().cell).toBe(cell);
      expect(builder().commands.length).toBeGreaterThan(0);
      expect(builder().fsckRepos.length).toBeGreaterThan(0);
    }
  });

  test("pins NFC and NFD pathname bytes in the description", () => {
    expect(Buffer.from(NFC_FILENAME).toString("hex")).toBe(NFC_FILENAME_HEX);
    expect(Buffer.from(NFD_FILENAME).toString("hex")).toBe(NFD_FILENAME_HEX);
    const unicode = GIT_FIXTURE_BUILDERS["s3-unicode"]();
    expect(unicode.tree.find((entry) => entry.path.endsWith(NFC_FILENAME))?.pathHex).toBe(NFC_FILENAME_HEX);
    expect(unicode.tree.find((entry) => entry.path.endsWith(NFD_FILENAME))?.pathHex).toBe(NFD_FILENAME_HEX);
  });

  test("constructs fsck-valid repositories for every non-LFS description", async () => {
    for (const builder of Object.values(GIT_FIXTURE_BUILDERS)) {
      const description = builder();
      if (description.needsGitLfs) continue;
      const { root } = await executeDescription(description);
      for (const repo of description.fsckRepos) {
        const proc = Bun.spawnSync(["git", "-C", path.join(root, repo), "fsck", "--no-dangling"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(proc.exitCode, `${description.cell}/${repo}: ${proc.stderr.toString()}`).toBe(0);
      }
    }
  }, 60_000);

  test("shared preflight refusals drift-fail against product code", async () => {
    const modules = await executeDescription(buildS1InitializedSubmodule());
    const shallow = await executeDescription(buildS4Shallow());
    expect((await gitPreflight(path.join(modules.root, "s1-a"))).reason).toBe(GIT_LAYOUT_REFUSALS.modules);
    expect((await gitPreflight(path.join(shallow.root, "s4-shallow"))).reason).toBe(GIT_LAYOUT_REFUSALS.shallow);
  }, 30_000);

  test("shared case-collision refusal drift-fails against manifest validation", () => {
    const fixture = buildS3CaseCollision();
    const files = fixture.tree
      .filter((entry) => entry.kind === "file")
      .map((entry) => ({ path: entry.path, type: "file", sha256: "0".repeat(64), size: 1, mode: 0o644 }));
    expect(validateManifest({ manifestSchema: 1, files })).toEqual({ ok: false, error: GIT_LAYOUT_REFUSALS.caseCollision });
  });

  test("LFS fixtures commit the canonical pointer while retaining payload bytes", async () => {
    const payloadOid = createHash("sha256").update(LFS_PAYLOAD).digest("hex");
    const expectedPointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${payloadOid}\nsize ${Buffer.byteLength(LFS_PAYLOAD)}\n`;
    for (const cell of ["s2-configured", "s2-unconfigured"] as const) {
      const { root } = await executeDescription(GIT_FIXTURE_BUILDERS[cell]());
      const repo = path.join(root, cell);
      const pointer = Bun.spawnSync(["git", "-C", repo, "cat-file", "-p", "refs/heads/main:asset.bin"], { stdout: "pipe", stderr: "pipe" });
      expect(pointer.exitCode, pointer.stderr.toString()).toBe(0);
      expect(pointer.stdout.toString()).toBe(expectedPointer);
      expect(await readFile(path.join(repo, "asset.bin"), "utf8")).toBe(LFS_PAYLOAD);
    }
  });

  test("operation fixtures enter genuine conflicts and abort restores clean main", async () => {
    const ident = ["-c", "user.name=Rig Tester", "-c", "user.email=rig@example.com"];
    for (const kind of ["merge", "rebase", "cherry-pick"] as const) {
      const cell = `s5-${kind}` as const;
      const { root } = await executeDescription(GIT_FIXTURE_BUILDERS[cell]());
      const repo = path.join(root, cell);
      const marker = kind === "merge" ? "MERGE_HEAD" : kind === "rebase" ? "rebase-merge" : "CHERRY_PICK_HEAD";
      const markerPath = path.join(repo, ".git", marker);
      const run = (args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
      const markerExists = () => Bun.spawnSync(["test", "-e", markerPath]).exitCode === 0;

      expect(run(["symbolic-ref", "--short", "HEAD"]).stdout.toString()).toBe("main\n");
      expect(run(["status", "--porcelain=v1"]).stdout.toString()).toBe("");
      expect(markerExists()).toBe(false);

      const started = kind === "merge"
        ? run([...ident, "merge", "operation-side"])
        : kind === "rebase"
          ? run(["rebase", "operation-side"])
          : run(["cherry-pick", "operation-side"]);
      expect(started.exitCode, started.stderr.toString()).toBe(1);
      expect(markerExists()).toBe(true);
      expect(run(["status", "--porcelain=v1"]).stdout.toString()).toBe("UU conflict.txt\n");
      if (kind === "rebase") expect(run(["symbolic-ref", "--short", "HEAD"]).exitCode).not.toBe(0);

      const aborted = run(kind === "merge" ? ["merge", "--abort"] : kind === "rebase" ? ["rebase", "--abort"] : ["cherry-pick", "--abort"]);
      expect(aborted.exitCode, aborted.stderr.toString()).toBe(0);
      expect(markerExists()).toBe(false);
      expect(run(["symbolic-ref", "--short", "HEAD"]).stdout.toString()).toBe("main\n");
      expect(run(["status", "--porcelain=v1"]).stdout.toString()).toBe("");
      expect(await readFile(path.join(repo, "conflict.txt"), "utf8")).toBe("incoming-side\n");
    }
  });

  test("fixture plan formatter drift-fails against the product formatter", () => {
    const summary = { captured: ["s1-a/mod"], deferred: [{ relPath: "s1-a", reason: `${GIT_LAYOUT_REFUSALS.modules} — section not captured` }] };
    const productPlan = {
      changed: true, authoredCfgHashByRepo: {}, captured: [...summary.captured], carried: [], deferred: [...summary.deferred],
      captureDeferrals: {}, configDeferrals: {}, captureObserved: [], configObserved: [], skipped: [], removed: [],
    } satisfies GitPushPlan;
    expect(formatFixturePlanLine(summary)).toBe(formatGitPushLine(productPlan));
  });

  test("op-state snapshot roots drift-fail against the product universe", () => {
    expect(GIT_LAYOUT_OP_STATE_ROOTS).toEqual([...OP_STATE_FILES, ...OP_STATE_DIRS]);
  });
});
