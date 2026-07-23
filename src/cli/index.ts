import "./api-base.js";

async function run(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "prompt-status") {
    const { runPromptStatus } = await import("./prompt-status.js");
    runPromptStatus(process.argv.slice(3));
    return;
  }
  if (cmd === "__tui-selftest") {
    const { runTuiSelftest } = await import("./tui-selftest.js");
    await runTuiSelftest();
    return;
  }

  const { main } = await import("./main-dispatch.js");
  try {
    await main();
  } finally {
    // The daemon keeps its crypto pool for the life of the process.
    if (cmd !== "__daemon-run") {
      const { shutdownCryptoPool } = await import("../engine/index.js");
      await shutdownCryptoPool();
    }
  }
}

async function runWithRuntimeAssertion(): Promise<void> {
  try {
    await run();
  } finally {
    if (process.env.RBOX_ASSERT_INK_NOT_LOADED === "1") {
      const marker = Symbol.for("rbox.prompt.ink-runtime-loaded");
      if ((globalThis as Record<symbol, unknown>)[marker] === true) {
        throw new Error("Ink runtime loaded during a non-interactive command");
      }
    }
  }
}

async function dispatch(): Promise<void> {
  if (process.argv[2] === "prompt-status") {
    await runWithRuntimeAssertion();
    return;
  }
  const { interactionPolicyForArgv, withInteractionPolicy } = await import("./prompt-policy.js");
  await withInteractionPolicy(interactionPolicyForArgv(process.argv.slice(2)), runWithRuntimeAssertion);
}

dispatch().catch(async (e) => {
  const message = e instanceof Error ? e.message : String(e);
  if (process.argv[2] === "prompt-status") {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    return;
  }
  const { fail } = await import("./style.js");
  fail(message);
});
