import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { attachGitSyncProgress } from "./sync-cmd.js";
import type { SyncDeps } from "./sync.js";
import type { Spinner } from "./spinner.js";

// attachGitSyncProgress collapses the pull-side per-repo git-sync forensic lines
// (design 43 §10) into a single updating spinner counter by default, only letting
// real problems (CONFLICT/WARNING) through as individual printed lines; --verbose
// restores the old one-line-per-repo dump untouched.

const origError = console.error;
let errors: string[] = [];
let spUpdates: string[] = [];

function fakeSpinner(): Spinner {
  return {
    update: (l) => void spUpdates.push(l),
    succeed: () => {},
    fail: () => {},
    stop: () => {},
  };
}

beforeEach(() => {
  errors = [];
  spUpdates = [];
  console.error = (...m: unknown[]) => void errors.push(m.map(String).join(" "));
});
afterEach(() => {
  console.error = origError;
});

describe("attachGitSyncProgress", () => {
  test("default (non-verbose): suppresses routine per-repo lines", () => {
    const deps = {} as SyncDeps;
    attachGitSyncProgress(deps, fakeSpinner());
    deps.onGitLog!("git-sync applied foo/repo");
    deps.onGitLog!("git-sync removed bar/repo (remote deleted; local .git untouched)");
    deps.onGitLog!("git-sync deferred baz/repo: receiver git busy");
    expect(errors).toEqual([]);
  });

  test("default (non-verbose): CONFLICT and WARNING lines still print", () => {
    const deps = {} as SyncDeps;
    attachGitSyncProgress(deps, fakeSpinner());
    deps.onGitLog!("git-sync CONFLICT foo/repo — local kept; remote preserved. Resolve manually.");
    deps.onGitLog!("git-sync WARNING bar/repo: post-apply containment check failed: boom");
    expect(errors.length).toBe(2);
    expect(errors[0]).toContain("git-sync CONFLICT foo/repo");
    expect(errors[1]).toContain("git-sync WARNING bar/repo");
  });

  test("default (non-verbose): onGitProgress drives a single updating counter", () => {
    const deps = {} as SyncDeps;
    attachGitSyncProgress(deps, fakeSpinner());
    deps.onGitProgress!(1, 100);
    deps.onGitProgress!(2, 100);
    expect(spUpdates).toEqual(["git sync ran for 1/100", "git sync ran for 2/100"]);
  });

  test("--verbose: every line prints as-is, no spinner counter wired", () => {
    const deps = {} as SyncDeps;
    attachGitSyncProgress(deps, fakeSpinner(), { verbose: true });
    deps.onGitLog!("git-sync applied foo/repo");
    deps.onGitLog!("git-sync CONFLICT bar/repo — local kept; remote preserved.");
    expect(errors).toEqual(["git-sync applied foo/repo", "git-sync CONFLICT bar/repo — local kept; remote preserved."]);
    expect(deps.onGitProgress).toBeUndefined();
  });
});
