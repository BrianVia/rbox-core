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
