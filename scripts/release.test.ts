import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Manifest } from "../src/cli/release-verify.js";
import {
  checkedInRboxVersion,
  deriveDevVersion,
  isWranglerMissingDiagnostic,
  nextInstallerSource,
  publishReleaseChannel,
  releaseChannelForInput,
  withTemporaryVersionFile,
} from "./release.js";
import type { ReleaseObjectStore } from "./release-publish.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test("derives an honest dev version from the checked-in version and short git sha", () => {
  const source = 'const CHECKED_IN_RBOX_VERSION = "1.7.3";\nexport const RBOX_VERSION = CHECKED_IN_RBOX_VERSION;\n';
  expect(checkedInRboxVersion(source)).toBe("1.7.3");
  expect(deriveDevVersion("1.7.3", "84c6037")).toBe("1.7.3-dev+84c6037");
  expect(deriveDevVersion("1.7.3", "84c6037a")).toBe("1.7.3-dev+84c6037a");
});

test("restores version.ts byte-for-byte when post-rewrite work throws", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-release-version-"));
  dirs.push(dir);
  const file = path.join(dir, "version.ts");
  const original = Buffer.from('/** checked in */\r\nconst CHECKED_IN_RBOX_VERSION = "1.7.3";\r\n');
  fs.writeFileSync(file, original);

  await expect(withTemporaryVersionFile(file, "1.7.3-dev+84c6037", async () => {
    expect(fs.readFileSync(file, "utf8")).toBe('export const RBOX_VERSION = "1.7.3-dev+84c6037";\n');
    throw new Error("simulated post-rewrite failure");
  })).rejects.toThrow("simulated post-rewrite failure");

  expect(fs.readFileSync(file)).toEqual(original);
});

describe("release input channel", () => {
  test.each([
    ["1.12.0", "latest"],
    ["2.0.0-beta.1", "next"],
    ["1.12.0-rc.0", "next"],
  ] as const)("%s -> %s", (version, expected) => {
    expect(releaseChannelForInput(version)).toBe(expected);
  });

  test("publisher refuses build metadata even though general semver supports it", () => {
    expect(() => releaseChannelForInput("1.12.0+build.1")).toThrow("must not contain build metadata");
  });
});

test("only wrangler's exact missing-key diagnostic permits next bootstrap", () => {
  expect(isWranglerMissingDiagnostic("[ERROR] The specified key does not exist.\n")).toBe(true);
  expect(isWranglerMissingDiagnostic("[ERROR] Authentication failed.\n")).toBe(false);
  expect(isWranglerMissingDiagnostic("request failed: 404")).toBe(false);
});

test("next installer uses the next manifest and its signed immutable artifact path", () => {
  const stable = fs.readFileSync(new URL("./install.sh", import.meta.url), "utf8");
  const next = nextInstallerSource(stable);
  expect(next).toContain('MANIFEST_BASE="$BASE/next"');
  expect(next).toContain('"$MANIFEST_BASE/version"');
  expect(next).toContain('URL="$BASE/bin/$ARTIFACT_PATH"');
  expect(next).toContain('"path":"([^"]+)"');
  expect(next).not.toBe(stable);
  expect(Bun.spawnSync(["sh", "-n"], { stdin: Buffer.from(next) }).exitCode).toBe(0);
  expect(fs.readFileSync(new URL("./install.sh", import.meta.url), "utf8")).toBe(stable);
});

const prereleaseManifest: Manifest = {
  version: "2.0.0-beta.1",
  keyId: "test",
  artifacts: {
    "rbox-linux-x64": {
      path: "v2.0.0-beta.1/rbox-linux-x64",
      sha256: "a".repeat(64),
    },
  },
};

function publisherFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-next-publish-"));
  dirs.push(dir);
  const dist = path.join(dir, "dist");
  fs.mkdirSync(dist);
  const installer = path.join(dir, "install.sh");
  fs.copyFileSync(new URL("./install.sh", import.meta.url), installer);
  const changelog = path.join(dir, "CHANGELOG.md");
  fs.writeFileSync(changelog, "# changelog\n");
  return { dist, installer, changelog };
}

test("prerelease publish reads and writes only next mutable state plus shared immutable bytes", async () => {
  const f = publisherFixture();
  const reads: string[] = [];
  const writes: Array<{ key: string; file: string }> = [];
  let activated = false;
  const store: ReleaseObjectStore = {
    put: async (key, file) => {
      writes.push({ key, file });
      if (key === "releases/next/manifest.json") activated = true;
    },
    sha256: async () => "a".repeat(64),
  };
  await publishReleaseChannel({
    channel: "next",
    manifest: prereleaseManifest,
    dist: f.dist,
    store,
    readLive: (key) => {
      reads.push(key);
      return activated ? { status: "found", version: prereleaseManifest.version } : { status: "missing" };
    },
    stableInstaller: f.installer,
    changelog: f.changelog,
  });

  expect(reads).toEqual(["releases/next/manifest.json", "releases/next/manifest.json"]);
  expect(writes.map(({ key }) => key)).toEqual([
    "releases/v2.0.0-beta.1/rbox-linux-x64",
    "releases/next/install.sh",
    "releases/next/manifest.json",
    "releases/next/manifest.json.sig",
  ]);
  expect(writes.find(({ key }) => key === "releases/next/install.sh")!.file).toBe(path.join(f.dist, "install-next.sh"));
  expect(reads).not.toContain("releases/version.json");
});

test("next monotonicity refuses an older prerelease without writes", async () => {
  const f = publisherFixture();
  const writes: string[] = [];
  await expect(publishReleaseChannel({
    channel: "next",
    manifest: prereleaseManifest,
    dist: f.dist,
    store: {
      put: async (key) => void writes.push(key),
      sha256: async () => "a".repeat(64),
    },
    readLive: () => ({ status: "found", version: "2.0.0-beta.2" }),
    stableInstaller: f.installer,
    changelog: f.changelog,
  })).rejects.toThrow("refusing rollback");
  expect(writes).toEqual([]);
});

test("next manifest read failures leave the write set empty", async () => {
  const f = publisherFixture();
  const writes: string[] = [];
  await expect(publishReleaseChannel({
    channel: "next",
    manifest: prereleaseManifest,
    dist: f.dist,
    store: {
      put: async (key) => void writes.push(key),
      sha256: async () => "a".repeat(64),
    },
    readLive: () => { throw new Error("authentication failed"); },
    stableInstaller: f.installer,
    changelog: f.changelog,
  })).rejects.toThrow("authentication failed");
  expect(writes).toEqual([]);
});

test("stable publication retains its exact mutable paths, ordering, and changelog tail", async () => {
  const f = publisherFixture();
  const stable: Manifest = {
    ...prereleaseManifest,
    version: "1.12.0",
    artifacts: {
      "rbox-linux-x64": { path: "v1.12.0/rbox-linux-x64", sha256: "a".repeat(64) },
    },
  };
  const events: string[] = [];
  let activated = false;
  await publishReleaseChannel({
    channel: "latest",
    manifest: stable,
    dist: f.dist,
    store: {
      put: async (key) => {
        events.push(`put:${key}`);
        if (key === "releases/version.json") activated = true;
      },
      sha256: async (key) => {
        events.push(`hash:${key}`);
        return "a".repeat(64);
      },
    },
    readLive: (key) => {
      events.push(`read:${key}`);
      return { status: "found", version: activated ? stable.version : "1.11.0" };
    },
    stableInstaller: f.installer,
    changelog: f.changelog,
  });
  expect(events).toEqual([
    "read:releases/version.json",
    "put:releases/v1.12.0/rbox-linux-x64",
    "hash:releases/v1.12.0/rbox-linux-x64",
    "put:releases/rbox-linux-x64",
    "put:releases/install.sh",
    "put:releases/version.json",
    "put:releases/version.json.sig",
    "read:releases/version.json",
    "put:releases/changelog.md",
  ]);
});

test("stable publication still refuses a missing live manifest before writes", async () => {
  const f = publisherFixture();
  const writes: string[] = [];
  await expect(publishReleaseChannel({
    channel: "latest",
    manifest: { ...prereleaseManifest, version: "1.12.0" },
    dist: f.dist,
    store: {
      put: async (key) => void writes.push(key),
      sha256: async () => "a".repeat(64),
    },
    readLive: () => ({ status: "missing" }),
    stableInstaller: f.installer,
    changelog: f.changelog,
  })).rejects.toThrow("refusing mutable publication");
  expect(writes).toEqual([]);
});
