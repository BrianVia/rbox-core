#!/usr/bin/env bun
/**
 * Lints just the files changed on this branch, without --quiet — so anti-slop's
 * "warn"-level rules (see .oxlintrc.json) stay visible for the files you're
 * actually touching, instead of being drowned out by the ~3,900 pre-existing
 * hits across the rest of the repo. The intent is incremental cleanup: every
 * change either fixes a warning it touches or at least sees it.
 *
 *   bun run lint:affected              # lint files changed vs merge-base(HEAD, origin/main)
 *   bun run lint:affected --base REF   # diff against REF instead
 *
 * The diff is BASE → working tree (committed + staged + unstaged + untracked),
 * matching scripts/test-affected.ts. Unlike `bun run lint`, this does not pass
 * --quiet, so warnings print; unlike `oxlint .`, it only lints what changed, so
 * pre-existing findings elsewhere don't drown out your diff. Warnings do not
 * fail the run (oxlint only exits non-zero on "error"-level findings) — this is
 * a visibility nudge, not a second gate on top of `bun run lint`.
 */
import { existsSync } from "node:fs";
import path from "node:path";

const HERE = "scripts/lint-affected.ts";
const REPO = process.cwd();

let baseArg: string | undefined;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]!;
  if (arg === "--base") baseArg = process.argv[++i];
  else if (arg.startsWith("--base=")) baseArg = arg.slice("--base=".length);
  else {
    console.error(`usage: bun ${HERE} [--base REF]`);
    process.exit(2);
  }
}

async function git(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${err.trim()}`);
  return out;
}

async function resolveBase(): Promise<string> {
  if (baseArg) return (await git("rev-parse", "--verify", `${baseArg}^{commit}`)).trim();
  for (const ref of ["origin/main", "main"]) {
    try {
      return (await git("merge-base", "HEAD", ref)).trim();
    } catch {
      /* ref absent (shallow clone, detached fixture repo) — try the next */
    }
  }
  throw new Error("cannot resolve a base: neither origin/main nor main exists; pass --base REF");
}

const base = await resolveBase();
const changed = new Set<string>();
for (const line of (await git("diff", "--name-only", base)).split("\n")) if (line) changed.add(line);
for (const line of (await git("ls-files", "--others", "--exclude-standard")).split("\n")) if (line) changed.add(line);

const LINTABLE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const files = [...changed].filter((f) => LINTABLE.test(f) && existsSync(path.join(REPO, f))).sort();

if (files.length === 0) {
  console.log(`lint-affected: no changed lintable files vs ${base.slice(0, 10)} — nothing to run`);
  process.exit(0);
}

console.log(`lint-affected: ${files.length} changed file(s) vs ${base.slice(0, 10)}`);
const proc = Bun.spawn(["bun", "x", "oxlint", ...files], { cwd: REPO, stdout: "inherit", stderr: "inherit" });
process.exit(await proc.exited);
