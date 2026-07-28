import { afterEach, beforeEach, expect, test } from "bun:test";
import { autostartCmd } from "../autostart-cmd.js";
import {
  absent,
  afterEachAutostartTest,
  beforeEachAutostartTest,
  home,
} from "./test-helpers.js";

beforeEach(beforeEachAutostartTest);
afterEach(afterEachAutostartTest);

for (const [lingerOutput, showsNote] of [["Linger=no\n", true], ["Linger=yes\n", false]] as const) {
  test(`autostart status ${showsNote ? "shows" : "hides"} the linger note for ${lingerOutput.trim()}`, async () => {
    const lines: string[] = [];
    const oldLog = console.log;
    console.log = (line?: unknown) => void lines.push(String(line ?? ""));
    try {
      await autostartCmd("status", { platform: "linux", home, loadCredentials: absent, exec: async () => lingerOutput });
    } finally {
      console.log = oldLog;
    }
    expect(lines.some((line) => line.includes("enable-linger"))).toBe(showsNote);
  });
}

test("autostart status hides the linger note when loginctl fails", async () => {
  const lines: string[] = [];
  const oldLog = console.log;
  console.log = (line?: unknown) => void lines.push(String(line ?? ""));
  try {
    await autostartCmd("status", {
      platform: "linux",
      home,
      loadCredentials: absent,
      exec: async () => { throw new Error("loginctl unavailable"); },
    });
  } finally {
    console.log = oldLog;
  }
  expect(lines.some((line) => line.includes("enable-linger"))).toBe(false);
});

