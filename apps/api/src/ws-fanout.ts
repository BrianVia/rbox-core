/**
 * Live notification fanout over hibernatable WebSockets — job #2 of the
 * WorkspaceSync DO (see workspace-sync.ts), factored out because it touches ONLY
 * the DurableObjectState (no commit/storage logic). Notification-only: clients
 * never depend on delivery for correctness. The hibernation lifecycle handlers
 * (webSocketMessage/Close/Error) MUST stay on the DO class — the runtime invokes
 * them by name on the instance — so they remain there and delegate as needed.
 */

export function acceptConnection(ctx: DurableObjectState, url: URL): Response {
  const deviceId = url.searchParams.get("device");
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  ctx.acceptWebSocket(server);
  server.serializeAttachment({ deviceId, connectedAt: Date.now() });
  return new Response(null, { status: 101, webSocket: client });
}

export function broadcast(
  ctx: DurableObjectState,
  message: string,
  opts: { maxSessionMs?: number; now?: number } = {},
): void {
  const maxSessionMs = opts.maxSessionMs ?? 0;
  const now = opts.now ?? Date.now();
  for (const ws of ctx.getWebSockets()) {
    if (ws.readyState !== WebSocket.OPEN) continue; // set can include CLOSING sockets
    if (maxSessionMs > 0 && isOverAge(ws, now, maxSessionMs)) {
      try {
        ws.close(1000, "session-max");
      } catch {
        /* already closing */
      }
      continue;
    }
    try {
      ws.send(message);
    } catch {
      // one dead socket must not abort the fanout
    }
  }
}

/** Design 105 §3.4 fail-closed: attachment hygiene cannot weaken the guarantee
 * that no committed frame is delivered past the configured session cap. */
function isOverAge(ws: WebSocket, now: number, maxSessionMs: number): boolean {
  let att: unknown;
  try {
    att = ws.deserializeAttachment();
  } catch {
    return true;
  }
  const connectedAt = att && typeof att === "object"
    ? (att as { connectedAt?: unknown }).connectedAt
    : undefined;
  if (typeof connectedAt !== "number" || !Number.isFinite(connectedAt) || connectedAt > now) return true;
  return now - connectedAt >= maxSessionMs;
}
