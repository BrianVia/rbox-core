import { test, expect } from "bun:test";
import { evaluateReadiness, parseMajor, minMajor, satisfiesMajor, type HostTool, type ProjectProbe } from "./doctor.js";

test("parseMajor pulls the first integer", () => {
  expect(parseMajor("v20.11.0")).toBe(20);
  expect(parseMajor("go1.21.5")).toBe(1);
  expect(parseMajor(undefined)).toBeNull();
});

test("minMajor decides simple forms, bails (null) on complex ranges", () => {
  expect(minMajor(">=18")).toBe(18);
  expect(minMajor("18")).toBe(18);
  expect(minMajor("^18.2.0")).toBe(18);
  expect(minMajor("1.21")).toBe(1);
  expect(minMajor(">= 3.11")).toBe(3);
  // complex/range forms we refuse to decide → warn, not fail
  expect(minMajor(">=14 <19")).toBeNull();
  expect(minMajor("16 || 18 || 20")).toBeNull();
  expect(minMajor("18.x")).toBeNull();
  expect(minMajor("*")).toBeNull();
});

test("satisfiesMajor is tri-state (ok / incompatible / undecidable)", () => {
  expect(satisfiesMajor("v20.0.0", ">=18")).toBe(true);
  expect(satisfiesMajor("v16.0.0", ">=18")).toBe(false);
  expect(satisfiesMajor("v20.0.0", "16 || 18 || 20")).toBeNull(); // complex → warn
  expect(satisfiesMajor(undefined, ">=18")).toBeNull();
});

const host = (over: Partial<HostTool> & { name: string }): HostTool => ({ present: true, ...over });

test("missing package manager → missing-tool, report not ok", () => {
  const probes: ProjectProbe[] = [{ dir: "", ecosystem: "node", tool: "pnpm", requirements: [] }];
  const r = evaluateReadiness(probes, [host({ name: "pnpm", present: false })]);
  expect(r.ok).toBe(false);
  expect(r.projects[0]!.status).toBe("missing-tool");
});

test("incompatible runtime major → version-mismatch, not ok", () => {
  const probes: ProjectProbe[] = [{ dir: "", ecosystem: "node", tool: "npm", requirements: [{ tool: "node", constraint: ">=18" }] }];
  const r = evaluateReadiness(probes, [host({ name: "npm", version: "10.0.0" }), host({ name: "node", version: "v16.20.0" })]);
  expect(r.ok).toBe(false);
  expect(r.projects[0]!.status).toBe("version-mismatch");
});

test("undecidable range → warn but still ok (advisory, never hard-fails)", () => {
  const probes: ProjectProbe[] = [{ dir: "", ecosystem: "node", tool: "npm", requirements: [{ tool: "node", constraint: "16 || 18 || 20" }] }];
  const r = evaluateReadiness(probes, [host({ name: "npm", version: "10.0.0" }), host({ name: "node", version: "v20.0.0" })]);
  expect(r.ok).toBe(true);
  expect(r.projects[0]!.status).toBe("warn");
});

test("tool present + satisfied requirement → ready", () => {
  const probes: ProjectProbe[] = [{ dir: "app", ecosystem: "node", tool: "pnpm", requirements: [{ tool: "node", constraint: ">=18" }] }];
  const r = evaluateReadiness(probes, [host({ name: "pnpm", version: "8.6.0" }), host({ name: "node", version: "v20.11.0" })]);
  expect(r.ok).toBe(true);
  expect(r.projects[0]!.status).toBe("ready");
});
