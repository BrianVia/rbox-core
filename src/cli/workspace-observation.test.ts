import { expect, test } from "bun:test";

test("WorkspaceObservation keeps its construction private and its capabilities depth-bound", async () => {
  const child = Bun.spawn([
    process.execPath,
    new URL("./workspace-observation.fixture.js", import.meta.url).pathname,
  ], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect(exit, stderr).toBe(0);
  const result = JSON.parse(stdout);
  expect(result.ambientResult).toEqual({
    depth: "ambient",
    hasDiagnosticAuthority: false,
    counts: { config: 1, daemon: 1, activity: 0, state: 0, adopt: 0, log: 0, metrics: 0 },
  });
  expect(result.unownedResult).toEqual({
    counts: { config: 1, daemon: 2, activity: 0, state: 0, adopt: 0, log: 0, metrics: 0 },
  });
  expect(result.localResult).toEqual({
    depth: "local",
    activity: new Date("2026-07-31T12:00:00.000Z").toISOString(),
    adopt: { status: "none" },
    deferrals: [],
    hasDiagnosticAuthority: true,
    counts: { config: 1, daemon: 3, activity: 1, state: 1, adopt: 1, log: 0, metrics: 0 },
  });
  expect(result.reboundResult).toEqual({
    counts: { config: 1, daemon: 4, activity: 1, state: 1, adopt: 1, log: 0, metrics: 0 },
  });
  expect(result.raceResult).toEqual({
    counts: { config: 1, daemon: 5, activity: 2, state: 1, adopt: 1, log: 1, metrics: 1 },
  });
});
