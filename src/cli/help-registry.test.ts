import { test, expect } from "bun:test";
import { COMMAND_HELP, helpFor, helpKeyFor, renderCommand, renderEssentialHelp, renderGroupedHelp } from "./help-registry.js";
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

test("git deferrals help registers both exclusive output modes", () => {
  const entry = helpFor("git deferrals");
  expect(entry).toHaveLength(1);
  expect(entry![0]!.usage).toBe("rbox git deferrals [--brief | --json]");
  expect(entry![0]!.flags?.map(({ flag }) => flag)).toEqual(["--brief", "--json"]);
});

test("guided setup help marks flags that only keyed setup honors", () => {
  const setup = byName.get("setup")!;
  const keyedOnly = new Set(["--dir <path>", "--daemon", "--pull-only", "--force"]);
  const flags = (setup.flags ?? []).filter(({ flag }) => keyedOnly.has(flag));
  expect(flags.map(({ flag }) => flag)).toEqual([...keyedOnly]);
  for (const { desc } of flags) expect(desc).toContain("(keyed setup only)");
});

test("per-command help: a command with registered sub-verbs includes them", () => {
  expect(helpFor("key")?.map((entry) => entry.name)).toEqual([
    "key",
    "key status",
    "key save",
    "key backup",
    "key recover",
    "key genesis",
    "key create-ci",
    "key materialize",
    "key list",
    "key revoke",
  ]);
});

test("per-command help renders notes after usage", () => {
  const rendered = renderCommand(byName.get("restore")!);
  expect(rendered.indexOf("usage:")).toBeLessThan(rendered.indexOf("<file> is resolved inside"));
  expect(rendered).toContain("rbox trash restore");
});

test("per-command help: the deps group is currently empty (commented out, design 51)", () => {
  // Was "returns all its subcommands" while `deps` was live; the whole group is
  // disabled for now (index.ts, help-registry.ts), so there's nothing to return.
  expect(helpFor("deps")).toBeUndefined();
});

test("helpKeyFor resolves group subcommands to the leaf, else the group", () => {
  expect(helpKeyFor("track", ["~/x"])).toBe("track"); // a path positional is not a subcommand
  expect(helpKeyFor("device", ["approve"])).toBe("device"); // device has no per-sub entry
  expect(helpKeyFor("git", ["deferrals"])).toBe("git deferrals");
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
  expect(KNOWN_TOP_LEVEL.has("__boot-resume")).toBe(true);
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

test("essential screen matches the founder-approved top-level help", () => {
  expect(renderEssentialHelp()).toBe(`rbox — end-to-end encrypted sync for your dev folders

START
  setup   guided onboarding: account → workspace → syncing
  status  what's synced, what's running

SYNC
  start  begin background sync for this workspace
  stop   stop background sync
  sync   sync once, right now
  logs   follow the background-sync log

ADD A MACHINE
  pair     create a token on a signed-in machine
  connect  authorize + encrypt this machine with a pairing token

IF SOMETHING'S WRONG
  doctor  check workspace health
  trash   list/restore files rbox moved aside
  key     encryption: status, backup, recover

MORE
  rbox help --all        the full command reference
  rbox <command> --help  flags and details for one command

Exit codes: 0 ok, 1 error, 130 user cancel (Ctrl-C).`);
});

test("full-reference screen renders every public group and omits hidden commands", () => {
  const screen = renderGroupedHelp();
  // DEPENDENCIES omitted: the whole `deps` group is commented out (design 51),
  // so that group has zero entries and renderGroupedHelp skips its header.
  for (const g of ["GETTING STARTED", "SYNCING", "DEVICES & ACCOUNT", "BILLING & MAINTENANCE"]) {
    expect(screen).toContain(g);
  }
  expect(screen).not.toContain("DEPENDENCIES");
  expect(screen).toContain("setup");
  expect(screen).not.toContain("hydrate"); // disabled alongside `deps` (design 51)
  expect(screen).toMatch(/^\s*init\s/m);
});
