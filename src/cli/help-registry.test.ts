import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ALIAS_COMMANDS,
  COMMAND_HELP,
  KNOWN_TOP_LEVEL,
  PUBLIC_COMMANDS,
  helpFor,
  helpKeyFor,
  renderCommand,
  renderEssentialHelp,
  renderGroupedHelp,
  resolveAlias,
  resolveCommandAlias,
} from "./help-registry.js";

const firstWord = (s: string) => s.split(" ")[0]!;
const byName = new Map(COMMAND_HELP.map((c) => [c.name, c]));

test("per-command help: leaf lookup returns exactly that command", () => {
  const track = helpFor("track");
  expect(track).toHaveLength(1);
  expect(track![0]!.name).toBe("track");
  expect(track![0]!.usage).toContain("rbox track");
});

test("start help documents one trace flag for every diagnostic stream", () => {
  const start = byName.get("start")!;
  expect(start.usage).toContain("[--trace[=<streams>]]");
  expect(renderCommand(start)).toContain("trace all diagnostics, or select with --trace=propagation,held");
});

test("include help uses the founder-approved surface and track documents repeatable --include", () => {
  const include = byName.get("include")!;
  expect(renderCommand(include)).toContain("include — sync only the folders you include on this machine");
  expect(include.usage).toBe("rbox include [add <folder>… | remove <folder>…] [--json]");
  expect(include.notes).toEqual([
    "A machine that syncs only some folders receives changes but never sends them — push code out of it with git.",
    "Folders are workspace-relative, and a folder cannot cut a git repository in half.",
    "Removing a folder moves its files to the local trash; `rbox trash restore` undoes that.",
  ]);
  expect(include.examples).toEqual([
    "rbox include",
    "rbox include add Personal/repo-A",
    "rbox include remove Personal/repo-A",
  ]);
  expect(byName.has("scope")).toBe(false);
  expect(byName.get("track")?.flags).toContainEqual({
    flag: "--include <folder>",
    desc: "sync only this folder (repeat for more); implies this machine never sends changes",
    takesValue: true,
    repeatable: true,
  });
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

test("accepted hidden syntax stays out of rendered help", () => {
  expect(renderCommand(byName.get("setup")!)).not.toContain("--no-sync");
  expect(renderCommand(byName.get("track")!)).not.toContain("--device");
  expect(renderCommand(byName.get("track")!)).not.toContain("--no-interactive");
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
  expect(KNOWN_TOP_LEVEL.has("config")).toBe(true);
});

test("draft rbox config help and every leaf stay marked for founder sign-off", () => {
  const source = readFileSync(new URL("./help-registry.ts", import.meta.url), "utf8");
  expect(source.match(/<!-- FOUNDER-SIGN-OFF: draft copy for rbox config -->/g)).toHaveLength(4);
  expect(helpFor("config")?.map((entry) => entry.name)).toEqual([
    "config",
    "config add",
    "config regenerate",
    "config repair",
  ]);
});

test("every canonical registry head has one real lazy-dispatch or fast-path handler", () => {
  const dispatchSource = readFileSync(new URL("./main-dispatch.ts", import.meta.url), "utf8");
  const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const switchHandlers = [...dispatchSource.matchAll(/^    case "([^"]+)":/gm)]
    .map((match) => match[1]!)
    .filter((command) => !command.startsWith("__"));
  const fastPathHandlers: string[] = [];
  if (/if \(cmd === "--version" \|\| cmd === "-v" \|\| cmd === "version"\)/.test(dispatchSource)) {
    fastPathHandlers.push("version");
  }
  if (/if \(cmd === "prompt-status"\)/.test(indexSource)) {
    fastPathHandlers.push("prompt-status");
  }

  const registeredCanonicalHeads = new Set(
    COMMAND_HELP
      .filter((command) => !command.alias)
      .map((command) => firstWord(command.name)),
  );
  expect([...new Set([...switchHandlers, ...fastPathHandlers])].sort()).toEqual(
    [...registeredCanonicalHeads].sort(),
  );
  expect(dispatchSource.indexOf("resolveAlias(cmd, positional)")).toBeLessThan(
    dispatchSource.indexOf("switch (cmd)"),
  );
});

test("every deprecated alias is hidden and forwards to a real command path", () => {
  for (const alias of ALIAS_COMMANDS) {
    const entry = byName.get(alias)!;
    expect(entry.hidden, `alias ${alias} must be hidden`).toBe(true);
    expect(entry.alias, `alias ${alias} must name a forward target`).toBeDefined();
    // The forward target is itself a known top-level command (no dangling forward).
    expect(KNOWN_TOP_LEVEL.has(firstWord(resolveCommandAlias(alias)))).toBe(true);
  }
});

test("the registry's alias targets agree with the deprecations resolver (no drift)", () => {
  for (const alias of ALIAS_COMMANDS) {
    if (alias === "daemon") continue; // sub-routed (start/stop/logs/status) — covered in deprecations.test
    const resolved = resolveAlias(alias, []);
    expect(resolved, `resolveAlias(${alias}) should rewrite`).not.toBeNull();
    // e.g. registry alias "deps install" ↔ resolver { cmd: "deps", positional: ["install"] }.
    const target = [resolved!.cmd, ...resolved!.positional].join(" ");
    expect(target).toBe(resolveCommandAlias(alias));
  }
});

test("essential screen matches the founder-approved top-level help", () => {
  expect(renderEssentialHelp()).toBe(`rbox — end-to-end encrypted sync for your dev folders

GET STARTED
  rbox                   set up rbox, or pick what to do in this folder
  rbox status [PATH]     show one synced folder, or all when outside one

SYNC
  rbox sync [PATH]       sync once
  rbox start [PATH]      start background sync
  rbox stop [PATH]       stop background sync
  rbox logs [PATH]       show background-sync logs

ADD A MACHINE
  rbox pair              create a token on a machine that's already set up
  rbox connect TOKEN     authorize + encrypt this machine with that token

FIX
  rbox doctor [PATH]     explain what's wrong and what to run next

MORE
  rbox <command> --help  flags and details for one command
  rbox help --all        the full command reference

PATH names any location inside a synced folder; it selects that whole folder.
Exit codes: 0 ok, 1 error, 130 user cancel (Ctrl-C).`);
});

test("every workspace verb on the essential screen advertises its real [PATH] signature", () => {
  const screen = renderEssentialHelp();
  for (const command of ["status", "sync", "start", "stop", "logs", "doctor"]) {
    expect(screen, `${command} must show its argument`).toContain(`rbox ${command} [PATH]`);
  }
  // Later memo steps add these; never advertise a flag the CLI does not accept.
  expect(screen).not.toContain("status --all");
  expect(screen).not.toContain("doctor --all");
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

test("full-reference screen shows one row per top-level command, without flags", () => {
  const screen = renderGroupedHelp();
  // Subcommand families collapse into their parent's row; leaves keep their
  // registry entries for `rbox <cmd> --help` and completions.
  for (const family of ["key", "trash", "autostart", "git"]) {
    expect(screen.match(new RegExp(`^  ${family}[ <]`, "gm")), `${family} must render exactly one row`).toHaveLength(1);
  }
  expect(screen).not.toMatch(/^\s*key status/m);
  expect(screen).not.toMatch(/^\s*trash list/m);
  // Flags live in per-command help, never in the reference column.
  expect(screen).not.toContain("[--");
  // Positional shape survives the flag strip.
  expect(screen).toMatch(/^\s*doctor \[reset-journal\] \[path\]\s/m);
  expect(screen).toMatch(/^\s*restore <file>@<seq>\s/m);
});

test("family parents route their bare --help to the parent plus its leaves", () => {
  for (const family of ["trash", "autostart", "git"]) {
    const entries = helpFor(family)!;
    expect(entries[0]!.name).toBe(family);
    expect(entries.length).toBeGreaterThan(1);
    for (const sub of entries.slice(1)) expect(sub.name.startsWith(`${family} `)).toBe(true);
  }
});
