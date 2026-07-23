import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { openInBrowser, openAndShow, copyToClipboard, _setSpawner } from "./browser-open.js";

// The value here is the cross-platform command/args selection and the TTY / missing-
// binary control flow — not "is a string a string". We drive the real functions with
// an injected spawner (the module's test seam) and a forced platform/TTY, and assert
// the exact spawn shape + the never-throws fallbacks.

interface SpawnCall {
  cmd: string;
  args: readonly string[];
  opts: unknown;
}

let calls: SpawnCall[] = [];
let stdinWrites: string[] = [];
const origPlatform = process.platform;
const origIsTTY = process.stdout.isTTY;
const origLog = console.log;
let logs: string[] = [];

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}
function setTTY(on: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", { value: on, configurable: true });
}

/** A spawner that records the call and returns a child whose stdin captures writes.
 *  `withStdin: false` simulates a child with no stdin (drives the copy fallback). */
function fakeSpawner(opts: { withStdin?: boolean; throwSync?: boolean } = {}) {
  const { withStdin = true, throwSync = false } = opts;
  return (cmd: string, args: readonly string[], o: unknown) => {
    if (throwSync) throw new Error("spawn failed");
    calls.push({ cmd, args, opts: o });
    return {
      on() {},
      unref() {},
      stdin: withStdin
        ? {
            write(chunk: string) {
              stdinWrites.push(chunk);
            },
            end() {},
          }
        : null,
    };
  };
}

beforeEach(() => {
  calls = [];
  stdinWrites = [];
  logs = [];
  console.log = (...m: unknown[]) => void logs.push(m.map(String).join(" "));
});
afterEach(() => {
  _setSpawner();
  setPlatform(origPlatform);
  setTTY(origIsTTY);
  console.log = origLog;
});

describe("openInBrowser", () => {
  test("off a TTY it prints instead of spawning (CI / piped)", () => {
    setTTY(false);
    _setSpawner(fakeSpawner());
    expect(openInBrowser("https://x")).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("darwin uses `open <url>`", () => {
    setTTY(true);
    setPlatform("darwin");
    _setSpawner(fakeSpawner());
    expect(openInBrowser("https://x")).toBe(true);
    expect(calls[0]!.cmd).toBe("open");
    expect(calls[0]!.args).toEqual(["https://x"]);
  });

  test("win32 uses `cmd /c start \"\" <url>` (empty title so a URL with spaces isn't the window title)", () => {
    setTTY(true);
    setPlatform("win32");
    _setSpawner(fakeSpawner());
    openInBrowser("https://x");
    expect(calls[0]!.cmd).toBe("cmd");
    expect(calls[0]!.args).toEqual(["/c", "start", "", "https://x"]);
  });

  test("linux uses `xdg-open <url>`", () => {
    setTTY(true);
    setPlatform("linux");
    _setSpawner(fakeSpawner());
    openInBrowser("https://x");
    expect(calls[0]!.cmd).toBe("xdg-open");
    expect(calls[0]!.args).toEqual(["https://x"]);
  });

  test("a synchronous spawn failure is swallowed → returns false, never throws", () => {
    setTTY(true);
    setPlatform("darwin");
    _setSpawner(fakeSpawner({ throwSync: true }));
    expect(openInBrowser("https://x")).toBe(false);
  });
});

describe("openAndShow", () => {
  test("on open success it prints the opening verb + the url", () => {
    setTTY(true);
    setPlatform("darwin");
    _setSpawner(fakeSpawner());
    openAndShow("https://x", "Opening...", "Open this URL:");
    expect(logs.join("\n")).toContain("Opening...");
    expect(logs.join("\n")).toContain("https://x");
  });

  test("when it can't open (no TTY) it prints the fallback + the url", () => {
    setTTY(false);
    _setSpawner(fakeSpawner());
    openAndShow("https://x", "Opening...", "Open this URL:");
    const out = logs.join("\n");
    expect(out).toContain("Open this URL:");
    expect(out).toContain("https://x");
  });
});

describe("copyToClipboard", () => {
  test("darwin pipes the text into `pbcopy` on stdin", () => {
    setPlatform("darwin");
    _setSpawner(fakeSpawner());
    expect(copyToClipboard("https://x")).toBe(true);
    expect(calls[0]!.cmd).toBe("pbcopy");
    expect(stdinWrites).toEqual(["https://x"]);
  });

  test("win32 uses `clip`", () => {
    setPlatform("win32");
    _setSpawner(fakeSpawner());
    copyToClipboard("hi");
    expect(calls[0]!.cmd).toBe("clip");
  });

  test("linux tries xclip first with the clipboard selection args", () => {
    setPlatform("linux");
    _setSpawner(fakeSpawner());
    copyToClipboard("hi");
    expect(calls[0]!.cmd).toBe("xclip");
    expect(calls[0]!.args).toEqual(["-selection", "clipboard"]);
  });

  test("no usable clipboard child → returns false (caller prints the URL), never throws", () => {
    setPlatform("darwin");
    _setSpawner(fakeSpawner({ withStdin: false }));
    expect(copyToClipboard("hi")).toBe(false);
  });
});
