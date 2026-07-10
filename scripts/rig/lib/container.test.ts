import { describe, expect, test } from "bun:test";
import { inspectHasMounts, type Mount } from "./container.js";

const expected: Mount[] = [
  { source: "/worktrees/d93/src", target: "/app/src", readonly: true },
  { source: "/worktrees/d93/scripts", target: "/app/scripts", readonly: true },
];

describe("rig container checkout binding", () => {
  test("rejects a reusable globally named container mounted from another checkout", () => {
    const stale = [{
      configuration: {
        mounts: [
          { type: "bind", source: "/main/src", destination: "/app/src", options: ["ro"] },
          { type: "bind", source: "/main/scripts", destination: "/app/scripts", options: ["ro"] },
        ],
      },
    }];

    expect(inspectHasMounts(stale, expected)).toBe(false);
  });

  test("accepts the current checkout mounts and ignores unrelated extra mounts", () => {
    const current = [{
      configuration: {
        mounts: [
          { type: "bind", source: "/worktrees/d93/src", destination: "/app/src", options: ["ro"] },
          { type: "bind", source: "/worktrees/d93/scripts", destination: "/app/scripts", options: ["ro"] },
          { type: "bind", source: "/cache/workload", destination: "/workload", options: ["ro"] },
        ],
      },
    }];

    expect(inspectHasMounts(current, expected)).toBe(true);
  });

  test("fails closed on malformed or version-incompatible inspect output", () => {
    expect(inspectHasMounts([{ configuration: { mounts: "unknown" } }], expected)).toBe(false);
    expect(inspectHasMounts(null, expected)).toBe(false);
  });
});
