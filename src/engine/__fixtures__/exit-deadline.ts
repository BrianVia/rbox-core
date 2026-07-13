/** Race a spawned child's exit against a hard deadline. On timeout, kill it and
 *  fail with its stderr; otherwise assert a clean exit 0. Shared by the crypto
 *  pool exit regression tests (uncompiled + compiled), whose whole point is
 *  "the process must not outlive its work".
 *
 *  Deliberately free of bun:test/Bun-global types: the root tsconfig typechecks
 *  src/ under node types with *.test.ts excluded, so this non-test helper must
 *  stand on structural types alone (throwing is assertion enough — the calling
 *  test fails on any throw). */
interface SpawnedChild {
  exited: Promise<number>;
  kill(): void;
  stderr: unknown;
}

async function childStderr(child: SpawnedChild): Promise<string> {
  try {
    return await new Response(child.stderr as ReadableStream).text();
  } catch {
    return "<stderr unavailable>";
  }
}

export async function expectExitWithinDeadline(child: SpawnedChild, deadlineMs: number, label: string): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    deadline = setTimeout(() => resolve("timeout"), deadlineMs);
  });

  const result = await Promise.race([
    child.exited.then((code: number) => ({ code })),
    timedOut,
  ]);

  if (deadline) clearTimeout(deadline);
  if (result === "timeout") {
    child.kill();
    await child.exited;
    throw new Error(`${label} did not exit within ${deadlineMs}ms: ${await childStderr(child)}`);
  }

  if (result.code !== 0) {
    throw new Error(`${label} exited with code ${result.code}: ${await childStderr(child)}`);
  }
}
