import { expect, test } from "bun:test";
import { daemonProcessMatches } from "./daemon-control.js";

test("workspace daemon ownership uses one ps command read for both predicates", () => {
  let reads = 0;
  const root = "/tmp/rbox workspace";
  const matched = daemonProcessMatches(process.pid, root, () => {
    reads++;
    return `/usr/local/bin/rbox __daemon-run ${root}`;
  });
  expect(matched).toBe(true);
  expect(reads).toBe(1);
});

test("standalone daemon ownership remains marker-only", () => {
  let reads = 0;
  expect(daemonProcessMatches(process.pid, undefined, () => {
    reads++;
    return "/usr/local/bin/rbox __daemon-run /different/root";
  })).toBe(true);
  expect(reads).toBe(1);
});

const owns = (root: string, command: string): boolean =>
  daemonProcessMatches(process.pid, root, () => command);

test("a prefix sibling's daemon never owns the shorter root", () => {
  // The defect this replaced was a substring test: `/w/work-old` contains
  // `/w/work`, so a live daemon for the sibling claimed ownership — enough,
  // under pid reuse, to attribute another workspace's halt to this one.
  expect(owns("/w/work", "/usr/local/bin/rbox __daemon-run /w/work-old")).toBe(false);
  expect(owns("/w/work", "/usr/local/bin/rbox __daemon-run /w/work/nested")).toBe(false);
  expect(owns("/w/work", "/usr/local/bin/rbox __daemon-run /other/w/work")).toBe(false);
  // The root appearing anywhere but the daemon's own root argument is not ownership.
  expect(owns("/w/work", "/w/work/bin/rbox __daemon-run /w/other")).toBe(false);
});

test("the true owner still matches, in both spawn shapes", () => {
  expect(owns("/w/work", "/usr/local/bin/rbox __daemon-run /w/work")).toBe(true);
  // Dev shape: `bun <entry> __daemon-run <root>`.
  expect(owns("/w/work", "/usr/bin/bun /repo/src/cli/index.ts __daemon-run /w/work")).toBe(true);
  // ps output arrives newline-terminated.
  expect(owns("/w/work", "/usr/local/bin/rbox __daemon-run /w/work\n")).toBe(true);
});

test("normalized-path equivalence still owns", () => {
  expect(owns("/w/work/", "/usr/local/bin/rbox __daemon-run /w/work")).toBe(true);
  expect(owns("/w/work", "/usr/local/bin/rbox __daemon-run /w/work/")).toBe(true);
  expect(owns("/w/work", "/usr/local/bin/rbox __daemon-run /w//work")).toBe(true);
  expect(owns("/w/work", "/usr/local/bin/rbox __daemon-run /w/nested/../work")).toBe(true);
});

test("a root containing the marker text cannot mis-anchor the match", () => {
  const root = "/w/__daemon-run/work";
  expect(owns(root, `/usr/local/bin/rbox __daemon-run ${root}`)).toBe(true);
  expect(owns("/w/__daemon-run", `/usr/local/bin/rbox __daemon-run ${root}`)).toBe(false);
});

test("a marker that is only part of a larger token is not a marker", () => {
  expect(owns("/w/work", "/usr/local/bin/rbox not__daemon-run /w/work")).toBe(false);
  expect(owns("/w/work", "/usr/local/bin/rbox __daemon-runner /w/work")).toBe(false);
});
