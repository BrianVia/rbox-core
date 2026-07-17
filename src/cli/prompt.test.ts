import { expect, test } from "bun:test";
import path from "node:path";
import { expandUserPath, promptPath } from "./prompt.js";

test("expandUserPath implements the complete leading-tilde grammar", () => {
  const home = "/home/tester";
  expect(expandUserPath("~", home)).toBe(home);
  expect(expandUserPath("~/project", home)).toBe(path.join(home, "project"));
  for (const value of ["~user", "~user/project", "~foo"]) {
    expect(() => expandUserPath(value, home)).toThrow("~user paths aren't supported — use an absolute path");
  }
  expect(expandUserPath("project/~cache", home)).toBe("project/~cache");
  expect(expandUserPath("/tmp/~cache", home)).toBe("/tmp/~cache");
});

test("promptPath re-prompts unsupported tilde and resolves against injected cwd", async () => {
  const answers = ["~somebody/project", "relative/project"];
  const errors: string[] = [];
  const resolved = await promptPath({
    message: "path",
    cwd: "/injected/cwd",
    input: (async () => answers.shift()!) as never,
    writeStderr: (text) => void errors.push(text),
  });
  expect(resolved).toBe("/injected/cwd/relative/project");
  expect(resolved).not.toBe(path.resolve(process.cwd(), "relative/project"));
  expect(errors).toEqual(["~user paths aren't supported — use an absolute path\n"]);
});
