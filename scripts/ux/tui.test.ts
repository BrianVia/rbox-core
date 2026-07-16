import { describe, expect, test } from "bun:test";
import { DEV_API } from "./fresh-machine.js";
import {
  assertDirectDevRbox, containerTmuxPlan, keyTmuxArgs, parseTuiArgs, renderCommand, shellQuote,
  stripTrailingBlankLines, tmuxStartArgs, waitForStable,
} from "./tui.js";

describe("tui argument parsing", () => {
  test("parses every command and defaults", () => {
    expect(parseTuiArgs(["start", "--host", "--session", "s", "--home", "/tmp/rbox-ux/r/a", "--", "rbox", "setup"])).toEqual({ command: "start", session: "s", home: "/tmp/rbox-ux/r/a", cols: 100, rows: 30, child: ["rbox", "setup"], host: true });
    expect(parseTuiArgs(["keys", "--host", "--session", "s", "--slow", "hello", "Enter"])).toEqual({ command: "keys", session: "s", keys: ["hello", "Enter"], slow: true, host: true });
    expect(parseTuiArgs(["screen", "--host", "--session", "s", "--strip"])).toEqual({ command: "screen", session: "s", strip: true, host: true });
    expect(parseTuiArgs(["wait-idle", "--host", "--session", "s", "--timeout", "4"])).toEqual({ command: "wait-idle", session: "s", timeout: 4, host: true });
    expect(parseTuiArgs(["stop", "--host", "--session", "s"])).toEqual({ command: "stop", session: "s", host: true });
    expect(parseTuiArgs(["screen", "--run-id", "walk", "--session", "s"])).toEqual({ command: "screen", session: "s", strip: false, host: false, runId: "walk" });
  });

  test.each([
    [[], "missing command"],
    [["start", "--session", "s"], "requires --"],
    [["start", "--session", "s", "--home", "/x", "--", "sh", "-c", "rbox setup"], "direct `rbox`"],
    [["keys", "--session", "s"], "at least one"],
    [["screen", "--session", "s", "--wat"], "unknown option"],
    [["wait-idle", "--session", "s", "--timeout", "0"], "positive integer"],
    [["stop", "--session", "s", "--session", "x"], "duplicate option"],
  ] as const)("rejects invalid argv %#", (argv, message) => expect(() => parseTuiArgs([...argv])).toThrow(message));
});

test("container tmux plan targets the run container and injects start cwd/env", () => {
  expect(containerTmuxPlan("walk", ["capture-pane", "-p"])).toEqual({ name: "ux-walk", cmd: ["tmux", "capture-pane", "-p"] });
  expect(containerTmuxPlan("walk", ["new-session"], "/tmp/rbox-ux/walk/a")).toMatchObject({
    name: "ux-walk", cmd: ["tmux", "new-session"], home: "/tmp/rbox-ux/walk/a",
    env: { HOME: "/tmp/rbox-ux/walk/a", RBOX_API: DEV_API },
  });
  for (const args of [["send-keys", "-t", "s", "Enter"], ["capture-pane", "-p", "-t", "s"], ["kill-session", "-t", "s"]]) {
    expect(containerTmuxPlan("walk", args)).toEqual({ name: "ux-walk", cmd: ["tmux", ...args] });
  }
});

test("direct rbox DEV guard closes path, shell, env, and remote bypasses", () => {
  for (const safe of [["rbox", "setup"], ["rbox", "login", "--remote", DEV_API], ["rbox", `--remote=${DEV_API}`, "status"]]) expect(() => assertDirectDevRbox(safe)).not.toThrow();
  for (const unsafe of [
    ["/tmp/rbox", "setup"], ["./rbox", "setup"], ["env", `RBOX_API=${DEV_API}`, "rbox", "status"],
    ["sh", "-c", "rbox status"], ["bun", "src/cli/index.ts", "status"],
    ["rbox", "--remote", "https://api.rbox.to", "status"], ["rbox", "--remote=https://other.example"],
    ["rbox", "status", "RBOX_API=https://other.example"], ["rbox", "status", "x=https://api.rbox.to"],
    ["rbox", "--remote", `${DEV_API}.evil`],
  ]) expect(() => assertDirectDevRbox(unsafe)).toThrow();
});

test("POSIX renderer preserves empty, quotes, metacharacters, dashes, and unicode", () => {
  expect(shellQuote("a'b")).toBe("'a'\"'\"'b'");
  expect(renderCommand(["rbox", "", "a b", "$()", ";", "-x", "☃"])).toBe("exec 'rbox' '' 'a b' '$()' ';' '-x' '☃'");
});

test("tmux start plan fixes geometry, cwd, DEV env, and empty scrubbed values", () => {
  const args = tmuxStartArgs("walk", "/tmp/rbox-ux/r/a", 120, 40, ["rbox", "setup"]);
  expect(args.slice(0, 11)).toEqual(["new-session", "-d", "-E", "-s", "walk", "-x", "120", "-y", "40", "-c", "/tmp/rbox-ux/r/a"]);
  expect(args).toContain(`RBOX_API=${DEV_API}`);
  expect(args).toContain("RBOX_TOKEN=");
  expect(args).toContain("RBOX_KEY=");
  expect(args).toContain("RBOX_APP=");
  expect(args.at(-2)).toBe("--");
  expect(args.at(-1)).toBe("exec 'rbox' 'setup'");
});

test("named keys and text use distinct tmux modes", () => {
  expect(keyTmuxArgs("s", "Enter")).toEqual(["send-keys", "-t", "s", "--", "Enter"]);
  expect(keyTmuxArgs("s", "hello; $()")).toEqual(["send-keys", "-t", "s", "-l", "--", "hello; $()"]);
});

test("strip removes only trailing blank lines", () => {
  expect(stripTrailingBlankLines("a\n\n  \n")).toBe("a");
  expect(stripTrailingBlankLines("a\n\nb")).toBe("a\n\nb");
});

test("wait-idle returns when two consecutive captures are equal", async () => {
  const screens = ["loading", "ready", "ready", "ready"];
  let time = 0; let captures = 0;
  const result = await waitForStable(3, { capture: async () => screens[captures++] ?? "ready", sleep: async (ms) => { time += ms; }, now: () => time });
  expect(result).toEqual({ screen: "ready", stable: true });
  expect(captures).toBe(3);
});

test("wait-idle returns the final changing screen on timeout", async () => {
  let time = 0; let capture = 0;
  const result = await waitForStable(1, { capture: async () => String(capture++), sleep: async (ms) => { time += ms; }, now: () => time });
  expect(result.stable).toBeFalse();
  expect(result.screen).toBe("2");
});
