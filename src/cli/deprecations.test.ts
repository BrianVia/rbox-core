import { test, expect } from "bun:test";
import { resolveAlias } from "./deprecations.js";

test("simple renames forward to the canonical command and warn with the replacement", () => {
  expect(resolveAlias("link", ["~/code/app"])).toEqual({
    cmd: "track",
    positional: ["~/code/app"],
    notice: "note: 'rbox link' is now 'rbox track'.",
  });
  // hydrate/detect/doctor assertions removed along with the `deps` group itself
  // (design 50) — resolveAlias no longer rewrites them; see the test below.
});

test("hydrate/detect/doctor are no longer rewritten (deps group disabled, design 50)", () => {
  expect(resolveAlias("hydrate", ["/p"])).toBeNull();
  expect(resolveAlias("detect", [])).toBeNull();
  expect(resolveAlias("doctor", [])).toBeNull();
});

test("daemon start/stop/logs rewrite to the top-level verb, stripping the subcommand", () => {
  expect(resolveAlias("daemon", ["start", "/p"])).toEqual({
    cmd: "start",
    positional: ["/p"],
    notice: "note: 'rbox daemon …' is now 'rbox start/stop/logs'.",
  });
  expect(resolveAlias("daemon", ["stop"])).toMatchObject({ cmd: "stop", positional: [] });
  expect(resolveAlias("daemon", ["logs"])).toMatchObject({ cmd: "logs", positional: [] });
});

test("daemon status folds into `rbox status`", () => {
  expect(resolveAlias("daemon", ["status", "/p"])).toEqual({
    cmd: "status",
    positional: ["/p"],
    notice: "note: daemon status is now part of 'rbox status'.",
  });
});

test("a current (non-deprecated) command resolves to null (no rewrite, no notice)", () => {
  expect(resolveAlias("track", ["x"])).toBeNull();
  expect(resolveAlias("deps", ["install"])).toBeNull();
  expect(resolveAlias("status", [])).toBeNull();
});
