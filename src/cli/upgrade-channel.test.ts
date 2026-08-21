import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseUpgradeChannel,
  readUpgradeChannel,
  resolveUpgradeChannel,
  upgradeChannelPath,
  upgradeManifestBase,
  writeUpgradeChannel,
} from "./upgrade-channel.js";
import type { Manifest } from "./release-verify.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function executable(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-upgrade-channel-"));
  dirs.push(dir);
  const exe = path.join(dir, "rbox");
  await fs.writeFile(exe, "binary");
  return exe;
}

test("absent install-scoped channel defaults to latest and both choices persist", async () => {
  const exe = await executable();
  expect(await readUpgradeChannel(exe)).toBe("latest");
  await writeUpgradeChannel(exe, "next");
  expect(await readUpgradeChannel(exe)).toBe("next");
  await writeUpgradeChannel(exe, "latest");
  expect(await readUpgradeChannel(exe)).toBe("latest");
  expect((await fs.stat(upgradeChannelPath(exe))).mode & 0o777).toBe(0o644);
});

test("manifest URL base derives from the selected channel", () => {
  expect(upgradeManifestBase("https://api.rbox.to/", "latest")).toBe("https://api.rbox.to");
  expect(upgradeManifestBase("https://api.rbox.to/", "next")).toBe("https://api.rbox.to/next");
});

test("channel parser refuses every non-channel value", () => {
  expect(parseUpgradeChannel("latest")).toBe("latest");
  expect(parseUpgradeChannel("next")).toBe("next");
  expect(() => parseUpgradeChannel("beta")).toThrow("expected latest or next");
});

test("malformed persisted settings fail closed until an explicit selection repairs them", async () => {
  const exe = await executable();
  await fs.writeFile(upgradeChannelPath(exe), '{"schema":1,"channel":"beta"}\n');
  await expect(readUpgradeChannel(exe)).rejects.toThrow("expected latest or next");
  await writeUpgradeChannel(exe, "next");
  expect(await readUpgradeChannel(exe)).toBe("next");
});

const encoder = new TextEncoder();

function resolverFixture(versions: { next: string; stable: string }, failures: Set<string> = new Set()) {
  const urls: string[] = [];
  const fetchBytes = async (url: string): Promise<Uint8Array> => {
    urls.push(url);
    if (failures.has(url)) throw new Error(`unavailable: ${url}`);
    return encoder.encode(url.includes("/next/") ? "next" : "stable");
  };
  const verifyManifest = (bytes: Uint8Array): Manifest => {
    const source = new TextDecoder().decode(bytes) as "next" | "stable";
    if (failures.has(`verify:${source}`)) throw new Error(`invalid ${source}`);
    return { version: versions[source], keyId: "test", artifacts: {} };
  };
  return { urls, fetchBytes, verifyManifest };
}

test("persisted latest fetches only the stable manifest", async () => {
  const fixture = resolverFixture({ next: "2.0.0-beta.4", stable: "2.0.0" });
  const resolved = await resolveUpgradeChannel({
    remoteUrl: "https://releases.example/",
    requested: undefined,
    persisted: "latest",
    ...fixture,
  });
  expect(fixture.urls).toEqual([
    "https://releases.example/version",
    "https://releases.example/version.sig",
  ]);
  expect(resolved).toMatchObject({ channel: "latest", supersedesNext: false, stableUnavailable: false });
});

test.each([
  ["stable behind", "2.0.0-beta.4", "1.12.0"],
  ["versions equal", "2.0.0-beta.4", "2.0.0-beta.4"],
  ["numeric prerelease on next is ahead", "2.0.0-beta.10", "2.0.0-beta.9"],
])("persisted next stays next when %s", async (_label, next, stable) => {
  const fixture = resolverFixture({ next, stable });
  const resolved = await resolveUpgradeChannel({
    remoteUrl: "https://releases.example",
    requested: undefined,
    persisted: "next",
    ...fixture,
  });
  expect(fixture.urls).toEqual([
    "https://releases.example/next/version",
    "https://releases.example/next/version.sig",
    "https://releases.example/version",
    "https://releases.example/version.sig",
  ]);
  expect(resolved).toMatchObject({ channel: "next", manifest: { version: next }, supersedesNext: false });
});

test("persisted next adopts a newer stable", async () => {
  const fixture = resolverFixture({ next: "2.0.0-beta.4", stable: "2.0.0" });
  const resolved = await resolveUpgradeChannel({
    remoteUrl: "https://releases.example",
    requested: undefined,
    persisted: "next",
    ...fixture,
  });
  expect(resolved).toMatchObject({
    channel: "latest",
    manifest: { version: "2.0.0" },
    supersedesNext: true,
    supersededNextVersion: "2.0.0-beta.4",
  });
});

test("explicit next wins without fetching stable", async () => {
  const fixture = resolverFixture({ next: "2.0.0-beta.4", stable: "2.0.0" });
  const resolved = await resolveUpgradeChannel({
    remoteUrl: "https://releases.example",
    requested: "next",
    persisted: "latest",
    ...fixture,
  });
  expect(fixture.urls).toEqual([
    "https://releases.example/next/version",
    "https://releases.example/next/version.sig",
  ]);
  expect(resolved).toMatchObject({ channel: "next", supersedesNext: false });
});

test.each([
  ["stable fetch", new Set(["https://releases.example/version"])],
  ["stable verification", new Set(["verify:stable"])],
])("persisted next fails open when %s fails", async (_label, failures) => {
  const fixture = resolverFixture({ next: "2.0.0-beta.4", stable: "2.0.0" }, failures);
  const resolved = await resolveUpgradeChannel({
    remoteUrl: "https://releases.example",
    requested: undefined,
    persisted: "next",
    ...fixture,
  });
  expect(resolved).toMatchObject({ channel: "next", stableUnavailable: true, supersedesNext: false });
});

test("persisted next propagates a next fetch failure", async () => {
  const fixture = resolverFixture(
    { next: "2.0.0-beta.4", stable: "2.0.0" },
    new Set(["https://releases.example/next/version"]),
  );
  await expect(resolveUpgradeChannel({
    remoteUrl: "https://releases.example",
    requested: undefined,
    persisted: "next",
    ...fixture,
  })).rejects.toThrow("unavailable");
});
