# Design 105 — WebSocket change notification (PLACEHOLDER)

**Status: idea captured 2026-07-12; design NOT started.** Queued behind the
current perf wave (102 enforce, 84, 85). Full design pass + codex adversarial
review required before implementation.

## Problem

Receivers learn about new commits by polling `latest`. Measured ground truth
(founder's Brian.md experiment, 2026-07-12 00:08–00:10Z): keystroke→other-host
= **41.5s**, of which the receiver side was 16.4s (poll wait + pull). As the
perf program lands (102: commit ~12s→~2s; 84: manifest 41MB→single-digit; 85:
pull rescan→O(actions)), **poll latency becomes the dominant term** in
propagation. Target: single-digit-seconds end-to-end.

## Direction (load-bearing decisions, made at capture time)

- **Notify-only hint channel — NEVER data, NEVER correctness.** The socket
  carries "workspace seq N available" (+ possibly epoch-bump hints). The
  daemon reacts by running the EXACT same authenticated HTTP pull as today.
  Every WS failure degrades to current polling behavior: dead socket → poll
  backstop; lost notification → poll backstop; spoofed notification → one
  wasted (authenticated, harmless) poll. No E2EE material near the channel.
- **Server: WorkspaceSync DO + the Workers WebSocket Hibernation API** (built
  for holding many idle sockets with the DO evicted from memory — near-zero
  cost). The DO already knows the authoritative head; it notifies on head
  advance in the commit path.
- **Client: Bun's first-class WebSocket client** in the daemon. Reconnect with
  seq-compare (on reconnect, compare local seq vs `latest` once — catches any
  gap during disconnection immediately). Polling remains as the fallback AND
  as a slow backstop while connected (e.g. 5–10 min) so WS is purely additive.
- **Auth:** device-token handshake on upgrade, same trust base as the API.

## Known dial-in surface (the "new angle of stuff")

Laptop sleep/wake reconnect behavior; NAT/proxy idle timeouts (keepalive ping
interval vs battery cost on the Mac); reconnect storms after API deploys
(jittered backoff); multi-workspace fan-out per device; DO hibernation
interactions with the commit hot path; metrics (notify→pull-start latency
token in pull lines, numbers-only per the privacy rule).

## Gate sketch

Keystroke→other-host p50 ≤ push-wall + pull-wall + ~1s on the fleet
(propagation analyzer provides the measurement); zero correctness-suite
changes; battery/wakeup cost on the Mac within an agreed budget; kill switch
env flag; polling path provably unchanged when the flag is off or the socket
is down.
