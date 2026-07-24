import { expect, test } from "bun:test";

test("noninteractive prompts fail before evaluating Ink (isolated process)", async () => {
  const promptPath = new URL("./prompt.ts", import.meta.url).pathname;
  const sentinelPath = new URL("./prompt-runtime-sentinel.ts", import.meta.url).pathname;
  const script = `
    try {
      const { PromptUnavailableError, promptSelect } = await import(${JSON.stringify(promptPath)});
      const { inkRuntimeWasLoaded } = await import(${JSON.stringify(sentinelPath)});

      if (inkRuntimeWasLoaded() !== false) {
        console.error("Ink runtime was loaded before the noninteractive prompt");
        process.exit(1);
      }

      let rejection;
      try {
        await promptSelect({
          message: "unreachable",
          choices: [{ name: "No", value: false }],
        });
      } catch (error) {
        rejection = error;
      }

      if (rejection === undefined) {
        console.error("Noninteractive prompt unexpectedly resolved");
        process.exit(1);
      }
      if (!(rejection instanceof PromptUnavailableError)) {
        console.error("Noninteractive prompt rejected with the wrong error:", rejection);
        process.exit(1);
      }
      if (inkRuntimeWasLoaded() !== false) {
        console.error("Ink runtime was loaded after the noninteractive prompt rejected");
        process.exit(1);
      }

      process.exit(0);
    } catch (error) {
      console.error("Isolated prompt assertion failed unexpectedly:", error);
      process.exit(1);
    }
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
});
