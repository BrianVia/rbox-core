import { test, expect } from "bun:test";
import { compareFingerprints, EMPTY_SHA256, fingerprintScript, parseFingerprint } from "./convergence.js";

const line = (parts: string[]) => parts.join("\t");

test("parseFingerprint reads file + symlink records and counts files only", () => {
  const stdout = [line(["F", "./a.txt", "aaa"]), line(["L", "./link", "a.txt"]), line(["F", "./b.bin", "bbb"]), ""].join("\n");
  const fp = parseFingerprint(stdout);
  expect(fp.fileCount).toBe(2);
  expect(fp.entries.map((e) => e.path)).toEqual(["./a.txt", "./b.bin", "./link"]); // sorted
  expect(fp.entries.find((e) => e.path === "./link")).toEqual({ path: "./link", digest: "symlink:a.txt", kind: "symlink" });
});

test("parseFingerprint ignores malformed lines", () => {
  expect(parseFingerprint("garbage\nF\tonly-two-fields\n").entries).toEqual([]);
});

test("compareFingerprints detects identity, extras, and digest drift", () => {
  const a = parseFingerprint([line(["F", "./x", "1"]), line(["F", "./y", "2"])].join("\n"));
  const same = parseFingerprint([line(["F", "./y", "2"]), line(["F", "./x", "1"])].join("\n"));
  expect(compareFingerprints(a, same).identical).toBe(true);

  const drift = parseFingerprint([line(["F", "./x", "1"]), line(["F", "./y", "9"]), line(["F", "./z", "3"])].join("\n"));
  const div = compareFingerprints(a, drift);
  expect(div.identical).toBe(false);
  expect(div.onlyInB).toEqual(["./z"]);
  expect(div.differing).toEqual(["./y"]);
  expect(div.onlyInA).toEqual([]);
});

test("EMPTY_SHA256 is the sha256 of the empty string (empty-file survival check)", () => {
  // Guards the constant the scenario asserts against.
  expect(EMPTY_SHA256).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("fingerprintScript prunes .rbox and emits both file and symlink sweeps", () => {
  const s = fingerprintScript("/work/ws");
  expect(s).toContain("cd '/work/ws'");
  expect(s).toContain("-path ./.rbox -prune");
  expect(s).toContain("sha256sum");
  expect(s).toContain("readlink");
});
