import { describe, expect, test } from "bun:test";
import {
  MAX_GIT_CONFIG_KEY_BYTES,
  MAX_GIT_CONFIG_KEYS,
  MAX_GIT_CONFIG_NAME_BYTES,
  MAX_GIT_CONFIG_SERIALIZED_BYTES,
  MAX_GIT_CONFIG_VALUE_BYTES,
  branchMergeOk,
  branchNameOk,
  branchRebaseOk,
  canonicalizeGitConfig,
  compareConfigKeysBytewise,
  hasHttpUserinfo,
  parseGitConfigKey,
  refComponentOk,
  remoteFetchOk,
  remoteNameOk,
  remoteUrlOk,
  validateCanonicalGitConfig,
} from "./config-sync.js";

describe("design 93 ref grammar boundary table", () => {
  const cases: Array<[string, boolean]> = [
    ["main", true], ["feature-1", true], ["é", true], ["@", true],
    ["", false], [".hidden", false], [".", false], ["two..dots", false], ["end.", false],
    ["x.lock", false], ["x.LOCK", true], ["x@{y", false], ["has space", false],
    ["has~tilde", false], ["has^caret", false], ["has:colon", false], ["has?question", false],
    ["has*star", false], ["has[bracket", false], ["has\\slash", false], ["has/slash", false],
    ["nul\0byte", false], ["tab\tbyte", false], ["del\u007fbyte", false],
  ];
  test.each(cases)("refComponentOk(%p) = %p", (value, expected) => expect(refComponentOk(value)).toBe(expected));

  test("branch names accept component paths and enforce the 120-byte name bound", () => {
    expect(branchNameOk("feature/deep/name")).toBe(true);
    expect(branchNameOk("feature//name")).toBe(false);
    expect(branchNameOk("a".repeat(MAX_GIT_CONFIG_NAME_BYTES))).toBe(true);
    expect(branchNameOk("a".repeat(MAX_GIT_CONFIG_NAME_BYTES + 1))).toBe(false);
    expect(branchNameOk("é".repeat(MAX_GIT_CONFIG_NAME_BYTES / 2))).toBe(true);
    expect(branchNameOk(`é${"a".repeat(MAX_GIT_CONFIG_NAME_BYTES - 1)}`)).toBe(false);
  });
});

describe("design 93 key allowlist boundary table", () => {
  const cases: Array<[string, boolean]> = [
    ["remote.origin.url", true], ["remote.a.fetch", true], ["remote.a-b_c.d.url", true],
    ["branch.main.remote", true], ["branch.feature/deep.merge", true], ["branch.release.v1.rebase", true],
    ["remote.0.url", true], ["remote.-bad.url", false], ["remote._bad.url", false],
    ["remote.origin.pushurl", false], ["remote.origin.mirror", false], ["branch.main.pushRemote", false],
    ["branch..remote", false], ["branch.bad..name.merge", false], ["branch.main.description", false],
    ["Remote.origin.url", false], ["remote.origin.URL", false], ["credential.helper", false],
    ["include.path", false], ["url.ssh://git@example/.insteadOf", false], ["remote.origin.url\n", false],
  ];
  test.each(cases)("parseGitConfigKey(%p) allowlisted = %p", (key, expected) => expect(!!parseGitConfigKey(key)).toBe(expected));

  test("remote name grammar and byte bound", () => {
    expect(remoteNameOk("a".repeat(MAX_GIT_CONFIG_NAME_BYTES))).toBe(true);
    expect(remoteNameOk("a".repeat(MAX_GIT_CONFIG_NAME_BYTES + 1))).toBe(false);
    expect(remoteNameOk("é")).toBe(false);
  });

  test("200-byte key bound is independently enforced", () => {
    expect(MAX_GIT_CONFIG_KEY_BYTES).toBe(200);
    expect(parseGitConfigKey(`branch.${"a/".repeat(70)}z.merge`)).toBeUndefined();
  });
});

describe("design 93 per-key value grammar boundary table", () => {
  const urlCases: Array<[string, boolean]> = [
    ["git@github.com:owner/repo.git", true], ["github.com:owner/repo.git", true],
    ["ssh://git@github.com/owner/repo.git", true], ["ssh://github.com/owner/repo.git", true],
    ["https://github.com/owner/repo.git", true], ["https://github.com/owner/repo.git?token=opaque", true],
    ["https://user@github.com/owner/repo.git", false], ["https://user:pass@github.com/repo", false],
    ["https://%75ser@github.com/repo", false], ["ssh://user:pass@github.com/repo", false],
    ["https:github.com/owner/repo.git", false], ["HTTPS://github.com/owner/repo.git", false],
    ["ssh:git@github.com/owner/repo.git", false], ["SSH://git@github.com/owner/repo.git", false],
    ["http://github.com/owner/repo.git", false], ["git://github.com/owner/repo.git", false],
    ["file:///tmp/repo", false], ["/tmp/repo", false], ["relative/repo", false],
    ["git@[::1]:owner/repo", false], ["ssh://[::1]/repo", false], ["host:", false],
    ["host::repo", false], ["host:path with space", false], ["https://", false],
    ["https://github.com/a\n", false],
  ];
  test.each(urlCases)("remoteUrlOk(%p) = %p", (value, expected) => expect(remoteUrlOk(value)).toBe(expected));

  test("userinfo detection is URL-parsed, including percent encoding", () => {
    expect(hasHttpUserinfo("https://user@example.com/repo")).toBe(true);
    expect(hasHttpUserinfo("https://%75ser@example.com/repo")).toBe(true);
    expect(hasHttpUserinfo("https://example.com/user@path")).toBe(false);
    expect(hasHttpUserinfo("ssh://git@example.com/repo")).toBe(false);
  });

  const fetchCases: Array<[string, string, boolean]> = [
    ["+refs/heads/*:refs/remotes/origin/*", "origin", true],
    ["refs/heads/main:refs/remotes/origin/main", "origin", true],
    ["+refs/heads/release:refs/remotes/up-stream/release", "up-stream", true],
    ["refs/heads/*:refs/remotes/origin/main", "origin", false],
    ["refs/heads/main:refs/remotes/origin/*", "origin", false],
    ["refs/heads/a/b:refs/remotes/origin/a", "origin", false],
    ["refs/tags/v1:refs/remotes/origin/v1", "origin", false],
    ["refs/heads/main:refs/heads/main", "origin", false],
    ["refs/heads/main:refs/remotes/other/main", "origin", false],
    ["refs/heads/.bad:refs/remotes/origin/main", "origin", false],
    ["refs/heads/main", "origin", false],
  ];
  test.each(fetchCases)("remoteFetchOk(%p, %p) = %p", (value, remote, expected) => expect(remoteFetchOk(value, remote)).toBe(expected));

  test("branch merge and rebase tables", () => {
    for (const value of ["refs/heads/main", "refs/heads/feature/deep", "refs/heads/é"]) expect(branchMergeOk(value)).toBe(true);
    for (const value of ["main", "refs/tags/v1", "refs/heads/", "refs/heads/a//b", "refs/heads/.bad"]) expect(branchMergeOk(value)).toBe(false);
    for (const value of ["true", "false", "merges", "interactive"]) expect(branchRebaseOk(value)).toBe(true);
    for (const value of ["yes", "TRUE", "preserve", "", "true\n"]) expect(branchRebaseOk(value)).toBe(false);
  });
});

describe("design 93 canonicalization and wire bounds", () => {
  const valid = () => ({
    "branch.main.merge": ["refs/heads/main"],
    "branch.main.rebase": ["false"],
    "branch.main.remote": ["origin"],
    "remote.origin.fetch": ["+refs/heads/*:refs/remotes/origin/*"],
    "remote.origin.url": ["https://example.com/repo.git"],
  });

  test("projects the allowlist, sorts keys bytewise, preserves value order, and de-duplicates", () => {
    const result = canonicalizeGitConfig([
      ["user.email", "secret@example.com"],
      ["remote.origin.url", "https://example.com/two"],
      ["branch.main.remote", "origin"],
      ["remote.origin.fetch", "refs/heads/main:refs/remotes/origin/main"],
      ["remote.origin.url", "https://example.com/one"],
      ["remote.origin.url", "https://example.com/two"],
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.config)).toEqual([
      "branch.main.remote",
      "remote.origin.fetch",
      "remote.origin.url",
    ]);
    expect(result.config["remote.origin.url"]).toEqual(["https://example.com/two", "https://example.com/one"]);
    expect(result.rejected).toEqual([]);
  });

  test("skips credential-bearing URLs and dangling branch remotes with explicit findings", () => {
    const result = canonicalizeGitConfig([
      ["remote.origin.url", "https://token@example.com/repo"],
      ["branch.main.remote", "origin"],
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual({});
    expect(result.rejected.map(({ credential, reason }) => ({ credential, reason }))).toEqual([
      { credential: true, reason: "invalid value grammar" },
      { credential: false, reason: "remote is not in this config" },
    ]);
  });

  test("unknown entries and non-bound grammar failures remain skippable", () => {
    const result = canonicalizeGitConfig([
      [`unknown.${"a".repeat(MAX_GIT_CONFIG_KEY_BYTES + 1)}`, "x".repeat(MAX_GIT_CONFIG_VALUE_BYTES + 1)],
      ["branch.main.rebase", "TRUE"],
      ["remote.origin.url", "https://example.com/repo.git"],
    ]);
    expect(result).toMatchObject({
      ok: true,
      config: { "remote.origin.url": ["https://example.com/repo.git"] },
      rejected: [{ key: "branch.main.rebase", reason: "invalid value grammar", credential: false }],
    });
  });

  test("wire validator requires exact bytewise key order", () => {
    expect(validateCanonicalGitConfig(valid()).ok).toBe(true);
    const unsorted = {
      "remote.origin.url": ["https://example.com/repo.git"],
      "branch.main.remote": ["origin"],
    };
    expect(validateCanonicalGitConfig(unsorted)).toEqual({ ok: false, reason: "config keys are not bytewise sorted" });
    expect(compareConfigKeysBytewise("branch.\u{10000}.merge", "branch.\ue000.merge")).toBeGreaterThan(0);
  });

  test("rejects non-objects, empty arrays, duplicates, unknown keys, bad values, and missing sibling remotes", () => {
    for (const input of [null, [], "config"]) expect(validateCanonicalGitConfig(input).ok).toBe(false);
    expect(validateCanonicalGitConfig({ "remote.origin.url": [] }).ok).toBe(false);
    expect(validateCanonicalGitConfig({ "remote.origin.url": ["https://example.com", "https://example.com"] }).ok).toBe(false);
    expect(validateCanonicalGitConfig({ "credential.helper": ["store"] }).ok).toBe(false);
    expect(validateCanonicalGitConfig({ "remote.origin.url": ["https://user@example.com"] }).ok).toBe(false);
    expect(validateCanonicalGitConfig({ "branch.main.remote": ["origin"] }).ok).toBe(false);
  });

  test("every control byte and DEL is rejected in keys and values", () => {
    for (let code = 0; code <= 0x1f; code++) {
      const control = String.fromCharCode(code);
      expect(parseGitConfigKey(`remote.ori${control}gin.url`)).toBeUndefined();
      expect(validateCanonicalGitConfig({ "remote.origin.url": [`https://example.com/${control}`] }).ok).toBe(false);
    }
    expect(parseGitConfigKey("remote.ori\u007fgin.url")).toBeUndefined();
    expect(validateCanonicalGitConfig({ "remote.origin.url": ["https://example.com/\u007f"] }).ok).toBe(false);
  });

  test("key count is accepted at 512 and rejected at 513", () => {
    expect(MAX_GIT_CONFIG_KEYS).toBe(512);
    const at = Object.fromEntries(Array.from({ length: MAX_GIT_CONFIG_KEYS }, (_, i) => [`remote.r${String(i).padStart(3, "0")}.url`, [`https://e.test/${i}`]]));
    expect(validateCanonicalGitConfig(at).ok).toBe(true);
    expect(validateCanonicalGitConfig({ ...at, "remote.zz.url": ["https://e.test/z"] }).ok).toBe(false);
  });

  test("value bytes are accepted at 1024 and rejected at 1025", () => {
    const prefix = "https://e.test/";
    const at = `${prefix}${"a".repeat(MAX_GIT_CONFIG_VALUE_BYTES - prefix.length)}`;
    expect(new TextEncoder().encode(at)).toHaveLength(MAX_GIT_CONFIG_VALUE_BYTES);
    expect(validateCanonicalGitConfig({ "remote.origin.url": [at] }).ok).toBe(true);
    expect(validateCanonicalGitConfig({ "remote.origin.url": [`${at}a`] }).ok).toBe(false);
  });

  const overBoundsCases: Array<{
    label: string;
    bound: "key-count" | "key-bytes" | "name-bytes" | "value-bytes";
    entries: Array<readonly [string, string]>;
  }> = [
    {
      label: "513th projected key",
      bound: "key-count",
      entries: Array.from({ length: MAX_GIT_CONFIG_KEYS }, (_, i) => [`remote.r${String(i).padStart(3, "0")}.url`, `https://e.test/${i}`] as const),
    },
    {
      label: "201-byte otherwise-allowlisted key",
      bound: "key-bytes",
      entries: [[`branch.${"a".repeat(MAX_GIT_CONFIG_KEY_BYTES - "branch..merge".length + 1)}.merge`, "refs/heads/main"]],
    },
    {
      label: "121-byte otherwise-allowlisted remote name",
      bound: "name-bytes",
      entries: [[`remote.${"a".repeat(MAX_GIT_CONFIG_NAME_BYTES + 1)}.url`, "https://e.test/repo"]],
    },
    {
      label: "1025-byte otherwise-valid value",
      bound: "value-bytes",
      entries: [["remote.origin.url", `https://e.test/${"a".repeat(MAX_GIT_CONFIG_VALUE_BYTES - "https://e.test/".length + 1)}`]],
    },
  ];

  test.each(overBoundsCases)("capture returns a non-partial over-bounds outcome for $label", ({ bound, entries }) => {
    const result = canonicalizeGitConfig([["remote.valid.url", "https://e.test/valid"], ...entries]);
    expect(result).toMatchObject({ ok: false, overBounds: true, bound });
    expect("config" in result).toBe(false);
  });

  test("serialized projection is accepted through 64 KiB and returns over-bounds above it", () => {
    expect(MAX_GIT_CONFIG_SERIALIZED_BYTES).toBe(64 * 1024);
    const make = (valueLength: number) => Array.from({ length: 64 }, (_, i) => [`remote.r${String(i).padStart(2, "0")}.url`, `https://e.test/${"a".repeat(valueLength)}${i}`] as const);
    let low = 0;
    let high = MAX_GIT_CONFIG_VALUE_BYTES - "https://e.test/".length - 2;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const result = canonicalizeGitConfig(make(mid));
      if (result.ok) low = mid;
      else high = mid - 1;
    }
    const at = canonicalizeGitConfig(make(low));
    expect(at.ok).toBe(true);
    if (!at.ok) return;
    expect(new TextEncoder().encode(JSON.stringify(at.config)).length).toBeLessThanOrEqual(MAX_GIT_CONFIG_SERIALIZED_BYTES);
    const over = canonicalizeGitConfig(make(low + 1));
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over).toMatchObject({ overBounds: true, bound: "serialized-bytes" });
    expect("config" in over).toBe(false);
    expect(over.reason).toContain(String(MAX_GIT_CONFIG_SERIALIZED_BYTES));
  });
});
