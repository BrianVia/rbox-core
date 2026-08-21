import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Manifest } from "../src/cli/release-verify.js";
import {
  addAppArtifact,
  checkedInRboxVersion,
  deriveDevVersion,
  isWranglerMissingDiagnostic,
  nextInstallerSource,
  publishReleaseChannel,
  releaseChannelForInput,
  workflowPublishesChangelog,
  withTemporaryVersionFile,
} from "./release.js";
import { RELEASE_KEYS } from "../src/cli/release-key.js";
import { releaseSigningInput, verifyReleaseArtifacts } from "../src/cli/release-verify.js";
import { semverGt } from "../src/cli/semver.js";
import type { ReleaseObjectStore } from "./release-publish.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test("derives an honest dev version from the checked-in version and short git sha", () => {
  const source = 'const CHECKED_IN_RBOX_VERSION = "1.7.3";\nexport const RBOX_VERSION = CHECKED_IN_RBOX_VERSION;\n';
  expect(checkedInRboxVersion(source)).toBe("1.7.3");
  expect(deriveDevVersion("1.7.3", "84c6037")).toBe("1.7.3+dev.84c6037");
  expect(deriveDevVersion("1.7.3", "84c6037a")).toBe("1.7.3+dev.84c6037a");
  expect(() => deriveDevVersion("1.7.3+local", "84c6037")).toThrow("must not contain build metadata");
});

test.each(["1.7.3", "2.0.0-beta.1"])(
  "the official %s release outranks its metadata-only dev build",
  (release) => {
    const dev = deriveDevVersion(release, "84c6037");
    expect(semverGt(release, dev)).toBe(true);
    expect(semverGt(dev, release)).toBe(false);
    expect(semverGt(dev, deriveDevVersion(release, "84c6038"))).toBe(false);
  },
);

test("workflow changelog guard agrees with release channel derivation", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  expect(workflow).toContain("if: ${{ !contains(github.ref_name, '-') }}");
  for (const version of ["1.12.0", "2.0.0-beta.1", "1.12.0-rc.0"]) {
    expect(workflowPublishesChangelog(version)).toBe(releaseChannelForInput(version) === "latest");
  }
});

test("invalid release input surfaces the parser reason alongside usage", () => {
  const result = Bun.spawnSync(["bun", new URL("./release.ts", import.meta.url).pathname, "1.12.0+build.1"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("release version must not contain build metadata: 1.12.0+build.1");
  expect(result.stderr.toString()).toContain("usage: bun scripts/release.ts");
});

test("restores version.ts byte-for-byte when post-rewrite work throws", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-release-version-"));
  dirs.push(dir);
  const file = path.join(dir, "version.ts");
  const original = Buffer.from('/** checked in */\r\nconst CHECKED_IN_RBOX_VERSION = "1.7.3";\r\n');
  fs.writeFileSync(file, original);

  await expect(withTemporaryVersionFile(file, "1.7.3+dev.84c6037", async () => {
    expect(fs.readFileSync(file, "utf8")).toBe('export const RBOX_VERSION = "1.7.3+dev.84c6037";\n');
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
  expect(next).toContain(`printf '%s\\n' '{"schema":1,"channel":"next"}' > "$CHANNEL_TMP"`);
  expect(next).toContain('mv -f "$CHANNEL_TMP" "$DEST/rbox.channel.json"');
  expect(next).not.toContain('rm -f "$DEST/rbox.channel.json"');
  expect(stable).toContain('rm -f "$DEST/rbox.channel.json"');
  expect(next).not.toBe(stable);
  expect(Bun.spawnSync(["sh", "-n"], { stdin: Buffer.from(next) }).exitCode).toBe(0);
  expect(fs.readFileSync(new URL("./install.sh", import.meta.url), "utf8")).toBe(stable);
});

test("app input appends exactly one bound artifact after unchanged binary entries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-release-app-"));
  dirs.push(dir);
  const dist = path.join(dir, "dist");
  fs.mkdirSync(dist);
  const app = path.join(dir, "RboxBar-2.0.0.zip");
  fs.writeFileSync(app, "app zip");
  const artifacts: Manifest["artifacts"] = {
    "rbox-darwin-arm64": { sha256: "a".repeat(64), path: "v2.0.0/rbox-darwin-arm64" },
    "rbox-linux-arm64": { sha256: "b".repeat(64), path: "v2.0.0/rbox-linux-arm64" },
    "rbox-linux-x64": { sha256: "c".repeat(64), path: "v2.0.0/rbox-linux-x64" },
  };
  const before = JSON.stringify(artifacts);
  addAppArtifact(app, dist, "2.0.0", artifacts);
  expect(Object.keys(artifacts)).toEqual(["rbox-darwin-arm64", "rbox-linux-arm64", "rbox-linux-x64", "RboxBar.zip"]);
  expect(JSON.stringify(Object.fromEntries(Object.entries(artifacts).slice(0, 3)))).toBe(before);
  expect(artifacts["RboxBar.zip"]).toEqual({
    sha256: createHash("sha256").update("app zip").digest("hex"),
    path: "v2.0.0/RboxBar-2.0.0.zip",
  });
  expect(fs.readFileSync(path.join(dist, "RboxBar.zip"), "utf8")).toBe("app zip");
});

test("release verification gates a missing or sha-mismatched app zip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-release-app-verify-"));
  dirs.push(dir);
  const app = Buffer.from("signed app zip");
  const manifest: Manifest = {
    version: "2.0.0",
    keyId: "test-app-key",
    artifacts: { "RboxBar.zip": { sha256: createHash("sha256").update(app).digest("hex"), path: "v2.0.0/RboxBar-2.0.0.zip" } },
  };
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "jwk" }) as { x: string };
  RELEASE_KEYS.push({ keyId: manifest.keyId, pubKey: publicKey.x });
  const bytes = Buffer.from(JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "version.json"), bytes);
  fs.writeFileSync(path.join(dir, "version.json.sig"), sign(null, releaseSigningInput(bytes), keys.privateKey).toString("base64url"));
  try {
    expect(() => verifyReleaseArtifacts(dir, manifest.version)).toThrow("RboxBar.zip has no binary");
    fs.writeFileSync(path.join(dir, "RboxBar.zip"), "wrong bytes");
    expect(() => verifyReleaseArtifacts(dir, manifest.version)).toThrow("RboxBar.zip sha");
  } finally {
    RELEASE_KEYS.pop();
  }
});

test("stable and next installers persist their effective channel beside the installed binary", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-channel-install-"));
  dirs.push(dir);
  const dest = path.join(dir, "install");
  const fixtures = path.join(dir, "fixtures");
  const commands = path.join(dir, "commands");
  fs.mkdirSync(dest);
  fs.mkdirSync(fixtures);
  fs.mkdirSync(commands);

  const binary = Buffer.from("fixture rbox binary");
  const binaryFile = path.join(fixtures, "rbox-linux-x64");
  const manifestFile = path.join(fixtures, "version.json");
  fs.writeFileSync(binaryFile, binary);
  fs.writeFileSync(manifestFile, JSON.stringify({
    version: "2.0.0-beta.1",
    artifacts: {
      "rbox-linux-x64": {
        sha256: createHash("sha256").update(binary).digest("hex"),
        path: "v2.0.0-beta.1/rbox-linux-x64",
      },
    },
  }));
  fs.writeFileSync(path.join(commands, "uname"), `#!/bin/sh
[ "$1" = "-s" ] && printf '%s\\n' Linux || printf '%s\\n' x86_64
`);
  fs.writeFileSync(path.join(commands, "curl"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; OUT="$1" ;;
    https://*) URL="$1" ;;
  esac
  shift
done
case "$URL" in
  */version) cp "$FIXTURE_MANIFEST" "$OUT" ;;
  */bin/*) cp "$FIXTURE_BINARY" "$OUT" ;;
  *) exit 9 ;;
esac
`);
  fs.chmodSync(path.join(commands, "uname"), 0o755);
  fs.chmodSync(path.join(commands, "curl"), 0o755);

  const stableFile = new URL("./install.sh", import.meta.url).pathname;
  const nextFile = path.join(dir, "install-next.sh");
  fs.writeFileSync(nextFile, nextInstallerSource(fs.readFileSync(stableFile, "utf8")), { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: dir,
    PATH: `${commands}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    RBOX_INSTALL_DIR: dest,
    RBOX_DOWNLOAD_BASE: "https://releases.test",
    FIXTURE_MANIFEST: manifestFile,
    FIXTURE_BINARY: binaryFile,
  };

  fs.writeFileSync(path.join(dest, "rbox.channel.json"), '{"schema":1,"channel":"next"}\n');
  expect(Bun.spawnSync(["sh", stableFile, "--no-modify-path"], { env, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
  expect(fs.existsSync(path.join(dest, "rbox.channel.json"))).toBe(false);

  expect(Bun.spawnSync(["sh", nextFile, "--no-modify-path"], { env, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
  expect(fs.readFileSync(path.join(dest, "rbox.channel.json"), "utf8")).toBe('{"schema":1,"channel":"next"}\n');
  expect(fs.statSync(path.join(dest, "rbox.channel.json")).mode & 0o777).toBe(0o644);
});

const prereleaseManifest: Manifest = {
  version: "2.0.0-beta.1",
  keyId: "test",
  artifacts: {
    "rbox-linux-x64": {
      path: "v2.0.0-beta.1/rbox-linux-x64",
      sha256: "a".repeat(64),
    },
    "RboxBar.zip": {
      path: "v2.0.0-beta.1/RboxBar-2.0.0-beta.1.zip",
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
    "releases/v2.0.0-beta.1/RboxBar-2.0.0-beta.1.zip",
    "releases/next/install.sh",
    "releases/next/manifest.json",
    "releases/next/manifest.json.sig",
  ]);
  expect(writes.map(({ key }) => key)).not.toContain("releases/RboxBar.zip");
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
