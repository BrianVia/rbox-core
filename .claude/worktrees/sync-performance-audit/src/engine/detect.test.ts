import { test, expect } from "bun:test";
import { detectProjects, hydrateArgv, ECOSYSTEM_RULES } from "./detect.js";

const ids = (files: string[]) => detectProjects(files).map((p) => `${p.dir || "."}:${p.rule.id}`);

test("single node/npm project", () => {
  expect(ids(["package.json", "package-lock.json", "src/index.ts"])).toEqual([".:node/npm"]);
});

test("monorepo: independent nested projects each detected in their own dir", () => {
  const got = ids(["apps/web/package.json", "apps/web/pnpm-lock.yaml", "services/api/go.mod", "services/api/go.sum"]);
  expect(got).toEqual(["apps/web:node/pnpm", "services/api:go/modules"]);
});

test("workspace: root lockfile only — sub-packages without a lockfile are NOT separate projects", () => {
  // pnpm/npm/yarn workspaces keep ONE lockfile at the root; the root install
  // covers sub-packages. A sub package.json with no lockfile must not detect.
  const got = detectProjects(["pnpm-lock.yaml", "package.json", "packages/a/package.json", "packages/b/package.json"]);
  expect(got.map((p) => `${p.dir || "."}:${p.rule.id}`)).toEqual([".:node/pnpm"]);
});

test("multiple node lockfiles in one dir, no hint → AMBIGUOUS (no silent pick)", () => {
  const got = detectProjects(["package.json", "package-lock.json", "pnpm-lock.yaml"]);
  expect(got).toHaveLength(1);
  expect(got[0]!.ambiguous).toBe(true);
  expect(got[0]!.warnings.some((w) => w.startsWith("ambiguous"))).toBe(true);
});

test("multiple node lockfiles resolved by packageManager hint → not ambiguous", () => {
  const got = detectProjects(["package.json", "package-lock.json", "pnpm-lock.yaml"], { managerByDir: { "": "pnpm" } });
  expect(got[0]!.ambiguous).toBe(false);
  expect(got[0]!.rule.tool).toBe("pnpm");
});

test("multiple node lockfiles resolved by global --manager override → not ambiguous", () => {
  const got = detectProjects(["package.json", "yarn.lock", "package-lock.json"], { manager: "npm" });
  expect(got[0]!.ambiguous).toBe(false);
  expect(got[0]!.rule.tool).toBe("npm");
});

test("single lockfile is never ambiguous", () => {
  expect(detectProjects(["package.json", "pnpm-lock.yaml"])[0]!.ambiguous).toBe(false);
});

test("lockfile without its manifest → warning", () => {
  const got = detectProjects(["package-lock.json"]);
  expect(got[0]!.warnings.some((w) => w.includes("without package.json"))).toBe(true);
});

test("different ecosystems in the same dir both detected", () => {
  const got = ids(["go.mod", "go.sum", "package.json", "package-lock.json"]);
  expect(got.sort()).toEqual([".:go/modules", ".:node/npm"]);
});

// ── safety policy (the trust boundary) ─────────────────────────────────────

test("npm: scripts disabled by default; full run only with --allow-build", () => {
  const npm = ECOSYSTEM_RULES.find((r) => r.id === "node/npm")!;
  expect(hydrateArgv(npm, false)).toEqual(["ci", "--ignore-scripts"]);
  expect(hydrateArgv(npm, true)).toEqual(["ci"]);
});

test("pnpm: default disables BOTH lifecycle scripts and .pnpmfile.cjs", () => {
  const pnpm = ECOSYSTEM_RULES.find((r) => r.id === "node/pnpm")!;
  expect(hydrateArgv(pnpm, false)).toEqual(["install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile"]);
});

test("yarn declares .yarnrc.yml/.yarnrc as untrusted config (executor gates auto-run)", () => {
  const yarn = ECOSYSTEM_RULES.find((r) => r.id === "node/yarn")!;
  expect(yarn.untrustedConfigFiles).toContain(".yarnrc.yml");
  // managers without a repo-code config vector declare none
  expect(ECOSYSTEM_RULES.find((r) => r.id === "node/npm")!.untrustedConfigFiles).toEqual([]);
});

test("bun: lifecycle gated by default → no ignore-scripts flag needed, auto-runnable", () => {
  const bun = ECOSYSTEM_RULES.find((r) => r.id === "node/bun")!;
  expect(hydrateArgv(bun, false)).toEqual(["install", "--frozen-lockfile"]);
});

test("cargo fetch / go mod download run NO repo code → auto-runnable, plain args", () => {
  for (const id of ["rust/cargo", "go/modules"]) {
    const rule = ECOSYSTEM_RULES.find((r) => r.id === id)!;
    expect(rule.fetchRunsCode).toBe(false);
    expect(hydrateArgv(rule, false)).toEqual(rule.baseArgs);
  }
});

test("pip/poetry/bundler compile code that can't be disabled → blocked without --allow-build", () => {
  for (const id of ["python/uv", "python/poetry", "ruby/bundler"]) {
    const rule = ECOSYSTEM_RULES.find((r) => r.id === id)!;
    expect(rule.fetchRunsCode).toBe(true);
    expect(hydrateArgv(rule, false)).toBeNull();
    expect(hydrateArgv(rule, true)).toEqual(rule.baseArgs);
  }
});
