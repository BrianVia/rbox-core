import { test, expect } from "bun:test";
import { COMMAND_HELP, helpFor, helpKeyFor, renderGroupedHelp } from "./help-registry.js";
import { ALIAS_COMMANDS, KNOWN_TOP_LEVEL, PUBLIC_COMMANDS } from "./command-catalog.js";
import { resolveAlias } from "./deprecations.js";

const firstWord = (s: string) => s.split(" ")[0]!;
const byName = new Map(COMMAND_HELP.map((c) => [c.name, c]));

test("per-command help: leaf lookup returns exactly that command", () => {
  const track = helpFor("track");
  expect(track).toHaveLength(1);
  expect(track![0]!.name).toBe("track");
  expect(track![0]!.usage).toContain("rbox track");
});

test("per-command help: the deps group is currently empty (commented out, design 50)", () => {
  // Was "returns all its subcommands" while `deps` was live; the whole group is
  // disabled for now (index.ts, help-registry.ts), so there's nothing to return.
  expect(helpFor("deps")).toBeUndefined();
});

test("helpKeyFor resolves group subcommands to the leaf, else the group", () => {
  expect(helpKeyFor("track", ["~/x"])).toBe("track"); // a path positional is not a subcommand
  expect(helpKeyFor("device", ["approve"])).toBe("device"); // device has no per-sub entry
});

test("unknown command path has no help entry (caller falls back to the grouped screen)", () => {
  expect(helpFor("frobnicate")).toBeUndefined();
});

// ── registry invariants + registry ↔ deprecations cross-check (design 29) ────

test("the public surface (derived from the registry) and KNOWN_TOP_LEVEL stay consistent", () => {
  // PUBLIC_COMMANDS is derived from the registry, so every public command's
  // top-level token must be a command the dispatcher knows.
  for (const name of PUBLIC_COMMANDS) expect(KNOWN_TOP_LEVEL.has(firstWord(name))).toBe(true);
  expect(KNOWN_TOP_LEVEL.has("__daemon-run")).toBe(true); // internal, handled by the switch
});

test("every deprecated alias is hidden and forwards to a real command path", () => {
  for (const alias of ALIAS_COMMANDS) {
    const entry = byName.get(alias)!;
    expect(entry.hidden, `alias ${alias} must be hidden`).toBe(true);
    expect(entry.alias, `alias ${alias} must name a forward target`).toBeDefined();
    // The forward target is itself a known top-level command (no dangling forward).
    expect(KNOWN_TOP_LEVEL.has(firstWord(entry.alias!))).toBe(true);
  }
});

test("the registry's alias targets agree with the deprecations resolver (no drift)", () => {
  for (const alias of ALIAS_COMMANDS) {
    if (alias === "daemon") continue; // sub-routed (start/stop/logs/status) — covered in deprecations.test
    const resolved = resolveAlias(alias, []);
    expect(resolved, `resolveAlias(${alias}) should rewrite`).not.toBeNull();
    // e.g. registry alias "deps install" ↔ resolver { cmd: "deps", positional: ["install"] }.
    const target = [resolved!.cmd, ...resolved!.positional].join(" ");
    expect(target).toBe(byName.get(alias)!.alias!);
  }
});

test("grouped screen renders every public group and omits hidden commands", () => {
  const screen = renderGroupedHelp();
  // DEPENDENCIES omitted: the whole `deps` group is commented out (design 50),
  // so that group has zero entries and renderGroupedHelp skips its header.
  for (const g of ["GETTING STARTED", "SYNCING", "DEVICES & ACCOUNT", "BILLING & MAINTENANCE"]) {
    expect(screen).toContain(g);
  }
  expect(screen).not.toContain("DEPENDENCIES");
  expect(screen).toContain("setup");
  expect(screen).not.toContain("hydrate"); // disabled alongside `deps` (design 50)
  expect(screen).not.toMatch(/^\s*init\s/m); // init is hidden from the main screen
});
