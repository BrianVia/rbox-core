import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkedInRboxVersion, deriveDevVersion, withTemporaryVersionFile } from "./release.js";

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
