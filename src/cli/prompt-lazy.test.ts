import { expect, test } from "bun:test";
import { PromptUnavailableError, promptSelect } from "./prompt.js";
import { inkRuntimeWasLoaded } from "./prompt-runtime-sentinel.js";

test("noninteractive prompts fail before evaluating Ink", async () => {
  expect(inkRuntimeWasLoaded()).toBe(false);
  await expect(promptSelect({
    message: "unreachable",
    choices: [{ name: "No", value: false }],
  })).rejects.toBeInstanceOf(PromptUnavailableError);
  expect(inkRuntimeWasLoaded()).toBe(false);
});
