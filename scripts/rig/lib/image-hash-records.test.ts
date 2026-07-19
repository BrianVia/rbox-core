import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { deleteImageHashRecord, imageHashRecordPath, parseImageHashRecords, readImageHashRecord, writeImageHashRecord } from "./image-hash-records.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rig-image-hashes-"));
const file = path.join(dir, ".image-hash");
afterEach(() => fs.rmSync(file, { force: true }));

test("stores the shared image cache outside the checkout", () => {
  expect(imageHashRecordPath("/tmp")).toBe("/tmp/rbox-rig/image-hashes.json");
});

test("per-runner image records survive backend switching independently", () => {
  writeImageHashRecord(file, "apple-container", "apple-hash");
  writeImageHashRecord(file, "docker", "docker-hash");
  expect(readImageHashRecord(file, "apple-container")).toBe("apple-hash");
  expect(readImageHashRecord(file, "docker")).toBe("docker-hash");
  deleteImageHashRecord(file, "docker");
  expect(readImageHashRecord(file, "docker")).toBeUndefined();
  expect(readImageHashRecord(file, "apple-container")).toBe("apple-hash");
});

test("malformed/legacy records fail closed", () => {
  expect(() => parseImageHashRecords("plain-old-hash")).toThrow();
  expect(() => parseImageHashRecords('{"docker":42}')).toThrow("must be a string");
});
