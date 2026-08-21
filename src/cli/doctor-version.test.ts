import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkVersion } from "./doctor-cmd.js";
import type { WorkspaceConfig } from "./config.js";
import type { Manifest } from "./release-verify.js";
import { RBOX_VERSION } from "./version.js";

let sandbox: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-doctor-version-"));
});

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

const config = (): WorkspaceConfig => ({
  schema: "e2ee/v1",
  remoteWorkspaceId: "ws",
  projectId: "root",
  rootPath: sandbox,
  remoteUrl: "https://releases.example/",
  token: "",
  deviceId: "dev",
});

const manifest = (version: string): Manifest => ({ version, keyId: "test", artifacts: {} });

test.each([
  [RBOX_VERSION, `up to date (${RBOX_VERSION}, next channel)`, true],
  ["2.0.0-beta.5", "update available (2.0.0-beta.5, next channel)", false],
])("doctor reports the persisted next channel honestly for manifest %s", async (nextVersion, message, ok) => {
  const executable = path.join(sandbox, "rbox");
  await fs.writeFile(executable, "binary");
  await fs.writeFile(`${executable}.channel.json`, `${JSON.stringify({ schema: 1, channel: "next" })}\n`);
  const result = await checkVersion(undefined, config(), {
    isStandaloneBinary: () => true,
    executable,
    fetchBytes: async (url) => new TextEncoder().encode(url.includes("/next/") ? "next" : "stable"),
    verifyManifest: (bytes) => new TextDecoder().decode(bytes) === "next"
      ? manifest(nextVersion)
      : manifest("1.12.0"),
  });
  expect(result).toMatchObject({ ok, message, latest: nextVersion, current: RBOX_VERSION });
});

test("source doctor checks stable only and keeps stable message grammar", async () => {
  const urls: string[] = [];
  const result = await checkVersion(undefined, config(), {
    isStandaloneBinary: () => false,
    fetchBytes: async (url) => {
      urls.push(url);
      return new TextEncoder().encode("stable");
    },
    verifyManifest: () => manifest(RBOX_VERSION),
  });
  expect(urls).toEqual([
    "https://releases.example/version",
    "https://releases.example/version.sig",
  ]);
  expect(result).toMatchObject({ ok: true, message: `up to date (${RBOX_VERSION})`, latest: RBOX_VERSION });
});
