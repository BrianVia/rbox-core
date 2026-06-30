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

test("per-command help: a bare group token returns all its subcommands", () => {
  const deps = helpFor("deps");
  expect(deps!.map((c) => c.name).sort()).toEqual([
    "deps check",
    "deps drift",
    "deps install",
    "deps list",
    "deps notify",
  ]);
});

test("helpKeyFor resolves group subcommands to the leaf, else the group", () => {
  expect(helpKeyFor("deps", ["install"])).toBe("deps install");
  expect(helpKeyFor("deps", [])).toBe("deps");
  expect(helpKeyFor("deps", ["bogus"])).toBe("deps"); // unknown sub → group help
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
  for (const g of ["GETTING STARTED", "SYNCING", "DEPENDENCIES", "DEVICES & ACCOUNT", "BILLING & MAINTENANCE"]) {
    expect(screen).toContain(g);
  }
  expect(screen).toContain("setup");
  expect(screen).toContain("deps drift");
  expect(screen).not.toContain("hydrate"); // deprecated alias is hidden
  expect(screen).not.toMatch(/^\s*init\s/m); // init is hidden from the main screen
});
