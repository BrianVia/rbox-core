/** Turn a non-OK fetch Response into a user-facing Error. Raw body detail
 *  only under RBOX_DEBUG. `body` may be passed if the caller already read it. */
export async function friendlyHttpError(res: Response, what: string, body?: string): Promise<Error> {
  const status = res.status;
  let message: string;
  if (status === 401 || status === 403) message = `${what} failed: this device isn't authorized (HTTP ${status}) — run \`rbox login\` again`;
  else if (status === 404) message = `${what} failed: the server didn't recognize this request (HTTP 404) — check the value you passed and try again`;
  else if (status === 429) message = `${what} failed: rate-limited — wait a moment and try again`;
  else if (status >= 500) message = `${what} failed: the rbox service hit a problem (HTTP ${status}) — try again shortly`;
  else message = `${what} failed (HTTP ${status})`;

  if (process.env.RBOX_DEBUG) {
    const detail = (body ?? (await res.text().catch(() => ""))).slice(0, 500);
    if (detail) message += `\n  server said: ${detail}`;
  }
  return new Error(message);
}
