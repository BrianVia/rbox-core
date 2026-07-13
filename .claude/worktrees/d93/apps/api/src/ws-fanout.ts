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
  server.serializeAttachment({ deviceId });
  return new Response(null, { status: 101, webSocket: client });
}

export function broadcast(ctx: DurableObjectState, message: string): void {
  for (const ws of ctx.getWebSockets()) {
    if (ws.readyState !== WebSocket.OPEN) continue; // set can include CLOSING sockets
    try {
      ws.send(message);
    } catch {
      // one dead socket must not abort the fanout
    }
  }
}
