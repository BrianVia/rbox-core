import { expect } from "bun:test";

/** Race a spawned child's exit against a hard deadline. On timeout, kill it and
 *  fail with its stderr; otherwise assert a clean exit 0. Shared by the crypto
 *  pool exit regression tests (uncompiled + compiled), whose whole point is
 *  "the process must not outlive its work". */
export async function expectExitWithinDeadline(child: ReturnType<typeof Bun.spawn>, deadlineMs: number, label: string): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    deadline = setTimeout(() => resolve("timeout"), deadlineMs);
  });

  const result = await Promise.race([
    child.exited.then((code) => ({ code })),
    timedOut,
  ]);

  if (deadline) clearTimeout(deadline);
  if (result === "timeout") {
    child.kill();
    await child.exited;
    const stderr = await new Response(child.stderr as ReadableStream).text();
    throw new Error(`${label} did not exit within ${deadlineMs}ms: ${stderr}`);
  }

  const stderr = await new Response(child.stderr as ReadableStream).text();
  expect(result.code, stderr).toBe(0);
}
