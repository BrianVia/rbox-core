async function run(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "prompt-status") {
    const { runPromptStatus } = await import("./prompt-status.js");
    runPromptStatus(process.argv.slice(3));
    return;
  }

  const { main } = await import("./main-dispatch.js");
  await main();
}

run().catch(async (e) => {
  const message = e instanceof Error ? e.message : String(e);
  if (process.argv[2] === "prompt-status") {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    return;
  }
  const { fail } = await import("./style.js");
  fail(message);
});
