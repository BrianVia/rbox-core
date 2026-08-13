import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIgnoreMatcher, type IgnoreMatcher } from "./ignore.js";
import { scanManifest } from "./manifest.js";
import type { FileEntry, Manifest } from "./types.js";

const roots: string[] = [];
const asRoot = process.getuid?.() === 0;

afterEach(async () => {
  setSystemTime();
  for (const root of roots.splice(0)) {
    await fs.chmod(path.join(root, "locked"), 0o700).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-walk-pool-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "nested", "deeper"), { recursive: true });
  await fs.mkdir(path.join(root, "empty"));
  await fs.mkdir(path.join(root, "ignored", "sub"), { recursive: true });
  await fs.writeFile(path.join(root, ".rboxignore"), "ignored/\n");
  await fs.writeFile(path.join(root, "root.txt"), "root payload");
  await fs.writeFile(path.join(root, "nested", "a.txt"), "alpha");
  await fs.writeFile(path.join(root, "nested", "deeper", "b.bin"), Buffer.from([0, 1, 2, 3]));
  await fs.writeFile(path.join(root, "ignored", "sub", "hidden.txt"), "hidden");
  await fs.symlink("a.txt", path.join(root, "nested", "link"));
  return root;
}

function tracedMatcher(root: string) {
  const base = buildIgnoreMatcher(root);
  const calls: string[] = [];
  const matcher = {
    ignores(rel: string) { calls.push(`ignores:${rel}`); return base.ignores(rel); },
    prunes(rel: string) { calls.push(`prunes:${rel}`); return base.prunes?.(rel) ?? base.ignores(rel); },
    prunesForGitDiscovery(rel: string) {
      calls.push(`prunesForGitDiscovery:${rel}`);
      return base.prunesForGitDiscovery?.(rel) ?? base.ignores(rel);
    },
  } satisfies IgnoreMatcher;
  return {
    calls,
    matcher,
  };
}

async function serialManifest(root: string, matcher: IgnoreMatcher): Promise<Manifest> {
  const files: FileEntry[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = path.join(root, childRel);
      if (entry.isDirectory()) {
        const childDir = `${childRel}/`;
        matcher.prunesForGitDiscovery?.(childDir);
        if (matcher.prunes?.(childDir) ?? matcher.ignores(childDir)) continue;
        await walk(childRel);
      } else if (entry.isSymbolicLink()) {
        if (matcher.ignores(childRel) || matcher.ignores(`${childRel}/`)) continue;
        const target = await fs.readlink(abs);
        files.push({
          path: childRel, type: "symlink", symlinkTarget: target,
          sha256: createHash("sha256").update(target).digest("hex"),
          size: Buffer.byteLength(target), mode: 0o777, mtimeMs: 0,
        });
      } else if (entry.isFile()) {
        if (matcher.ignores(childRel)) continue;
        const [bytes, st] = await Promise.all([fs.readFile(abs), fs.stat(abs)]);
        files.push({
          path: childRel, type: "file",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: st.size, mode: st.mode & 0o777, mtimeMs: st.mtimeMs,
        });
      }
    }
  };
  await walk("");
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { generatedAt: new Date().toISOString(), files };
}

test("bounded walk is field-identical to an independent serial reference", async () => {
  const root = await fixture();
  setSystemTime(new Date("2026-08-13T12:00:00.000Z"));
  const expectedTrace = tracedMatcher(root);
  const actualTrace = tracedMatcher(root);

  const expected = await serialManifest(root, expectedTrace.matcher);
  const actual = await scanManifest(root, actualTrace.matcher);

  expect(actual).toEqual(expected);
  expect(actualTrace.calls.sort()).toEqual(expectedTrace.calls.sort());
});

test("bounded walk is deterministic across three scans", async () => {
  const root = await fixture();
  setSystemTime(new Date("2026-08-13T12:00:00.000Z"));
  const manifests = await Promise.all(Array.from({ length: 3 }, () => scanManifest(root)));
  expect(manifests[1]).toEqual(manifests[0]);
  expect(manifests[2]).toEqual(manifests[0]);
});

test("rules-changed abort fences queued work before the unpruned retry", async () => {
  const child = Bun.spawn([process.execPath, "test", path.join(import.meta.dir, "manifest-walk-abort.fixture.test.ts")], {
    env: { ...process.env, RBOX_WALK_ABORT_FIXTURE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(`${stdout}\n${stderr}`).toContain("1 pass");
});

test.skipIf(asRoot)("an unreadable directory retains the fail-loud classification", async () => {
  const root = await fixture();
  await fs.mkdir(path.join(root, "locked"));
  await fs.writeFile(path.join(root, "locked", "inside"), "inside");
  await fs.chmod(path.join(root, "locked"), 0o000);
  await expect(scanManifest(root)).rejects.toMatchObject({ code: "EACCES" });
});
