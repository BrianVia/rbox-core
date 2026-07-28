import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseUpgradeChannel,
  readUpgradeChannel,
  upgradeChannelPath,
  upgradeManifestBase,
  writeUpgradeChannel,
} from "./upgrade-channel.js";

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
