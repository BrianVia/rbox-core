# Design 87 — Agent sync keys ("sync your latest code to your agents, fast")

> **Implementation: 🟢 BUILT (v1 beta)** — server + CLI shipped 2026-07-08:
> `RBOX_KEY`, keyed `rbox setup --workspace`, PAT route gating, and `/agent.sh`.
> Dashboard management remains future work. GA remains gated on E2EE epoch
> rotation. Builds directly on [design 20](./20-cli-api-keys.md) (CLI/CI API
> keys). Status index: [`README.md`](./README.md).

**Status:** v1 beta implemented; review pass 1 resolved; GA still waits for P3
epoch rotation.
**Depends on:** design 20 (adopted wholesale as the mechanism), design 12 (full
E2EE), design 86 (paid-only plans — device caps per plan).
**Blocks:** the "sync your latest code to your agents" marketing line on
rbox.to — that copy does not ship until this does.

## 1. Why (the product story)

The agent era's default workflow is: spin up an ephemeral machine (devcontainer,
CI runner, Claude Code cloud session, Codex sandbox, a VM fleet), and the first
thing that machine needs is *your current working tree* — not the last commit,
the messy in-progress state rbox already syncs between your human machines.

Today that machine cannot join non-interactively (design 20 §6.1, design 12
§14.2): pairing tokens are single-use/10-min/human-minted, and a bare bearer
(`RBOX_TOKEN`) authenticates but holds no Master Key, so sync fails closed. The
audit of 2026-07-08 confirmed there is **no** reusable, image-bakeable
credential.

Design 20 already specifies the fix: one `RBOX_KEY` secret (bearer + device
keypair + wrapped MK + KEK cache) that `rbox key materialize` unpacks in a
fresh environment. This doc does three things design 20 deliberately left to
the human:

1. **Answers design 20's §10 open questions** so implementation can start.
2. **Specifies the agent-fleet deltas** — N concurrent VMs sharing one secret,
   device-cap interaction, the one-command bootstrap UX.
3. **Sets the release posture** — what ships now as beta vs. what gates GA on
   the epoch-rotation milestone.

## 2. Answers to design 20 §10 (normative)

**Q1 — Rotation gate.** Ship v1 as an **explicit-opt-in beta**, GA after epoch
rotation. Mechanics: `rbox key create-ci` requires `--expires` (per design 20
§7) AND prints the root-equivalence warning with a mandatory interactive
confirmation (or `--accept-root-key` for scripting the *creation*, never the
use). Docs and dashboard label the feature "beta". Rationale: prod currently
has one paying account (the founder); the corpus at risk is his own, and the
agent story is the next distribution wedge. Epoch rotation is hereby the
**next crypto milestone** and a named GA precondition — it already has a home:
prerequisite **P3** (epoch rotation) feeding **design 19** (crypto-revoke) in the index — design 20 Q4's dangling "doc 19" reference resolves there.

**Q2 — Scoped MK-less read-only key.** Stays future work (design 20 §6.5). The
agent use-case is read-mostly, but an MK-less key cannot run against the
current transport at all, and the agent story should not wait on a new
transport. v1 agents get a full device used pull-only by convention + tooling
(§4.3), with the honest caveat that the privilege is not actually reduced.

**Q3 — Admin-grade keys.** Accepted for v1 with design 20's mitigations
(mandatory expiry, default-deny route allowlist, loud creation warning). The
route allowlist is what keeps a leaked agent key from minting pairing tokens or
touching billing.

**Q4 — Numbering.** Rotation/revocation = prerequisite P3 + design 19
(crypto-revoke) — already indexed; no new design number needed.

**Q5 — Web issuance.** CLI-issues / web-manages, exactly as design 20 §7. No
change for agents: you mint the key once on your laptop, then bake it into your
agent platform's secret store.

**Q6 — Caps and expiry defaults.** Outstanding-key cap: **5 per account**
(mirrors `PAIR_ACTIVE_CAP`). `--expires` required; CLI suggests `90d`, hard max
**1 year**. Cap-and-kind mechanics, stated against the live code (§9 R1/R3):

- Expiring credentials are excluded from the durable-device count (`mint.ts`
  counts only `expires_at IS NULL AND revoked = 0`), so agent keys do not
  consume the per-plan device cap (design 86: solo 10 / pro 25). **But** live
  auth currently classifies *every* expiring token as `kind='web'`
  (`authenticate.ts:46`) and web principals are denied the crypto/sync routes
  (`worker.ts:245,255`). That heuristic is P4's shipped default-deny gate; implementation MUST refine it with
  explicit kind classification (design 20 §3's `devices.kind` column +
  the `rbox_pat_` recognizer): `api_key` principals are expiring AND
  sync-capable via their own allowlist. This is a named prerequisite, not a
  free ride on the existing exclusion.
- The 5-key cap counts **`devices` rows** with `kind='api_key' AND revoked=0
  AND expires_at > now` — enforcement state lives solely on `devices`; the
  `api_keys` sidecar stays purely descriptive (design 20 §3/R10). Creation
  must take the same race-safe path as `mintDevice`'s durable cap check.

## 3. The fleet question: one key, N concurrent VMs

Design 20 models one key = one E2EE device. Agents multiply: a user may run 10
sandboxes at once from the same baked secret. Decision:

**v1: shared device identity; a shared key is a pull-only fleet by rule.**

- All VMs materializing the same `RBOX_KEY` present the same `device_id` and
  the same roster identity. **Pull-only sharing is safe**: reads don't write
  roster or commit state, concurrent pulls are independent, and the roster
  doesn't bloat with per-VM entries (roster history is append-only — design
  12 — so per-VM admission would grow it unboundedly).
- **The server does not actually forbid concurrent same-identity pushes** —
  sequencing is workspace-head CAS (`workspace-sync.ts:287,300`), not keyed by
  device, so racing pushes resolve the same way they do between two distinct
  devices (one wins, one retries). The real reasons a shared key must not have
  multiple writers are worse than a race (§9 R5):
  - **Fanout/mirror metadata is keyed by the commit's `deviceId`**
    (`workspace-sync.ts:321,326`): the delivery path assumes one device_id ≡
    one replica. Sibling VMs sharing the writer's identity can mis-attribute
    the writer's commits as their own — missed notifications, skipped applies.
    This is a correctness hazard, not a style rule.
  - **Attribution collapses** (design 12 §374): committed device ids are the
    audit trail; N writers behind one id are indistinguishable.
- **Rule, stated precisely:** a shared key is for fleets that only consume
  changes from your *other* devices. Any agent that writes gets its own key
  (cap 5). Not "one live writer per shared key" — a writing sharer poisons
  the fanout assumptions for every sibling on that key.
- **Sharing is a blast-radius decision, not a security boundary** (§9 R4):
  every VM holding the bundle holds account-root authority (MK + roster-active
  identity). `--pull-only` is an honest-client convention; a modified client
  with the same bundle can write, admit, and revoke. The creation warning says
  this in as many words.
- **Future (post-rotation, P3/19+):** `materialize --fork` could mint per-VM
  ephemeral child devices so fleets get real per-VM identity for writes and
  per-VM auth revocation. Note the cleanup asymmetry (§9 R7): `expires_at`
  bounds only the *auth* row — roster entries and `device_keys` have no expiry
  and are append-only, so the E2EE security state of dead children is only
  truly retired by epoch rotation (P3 → design 19). Explicitly out of scope now;
  noted so the bundle format (§4.3) doesn't preclude it.

## 4. Agent UX (the deltas over design 20)

### 4.1 The one-command join (the primary interface)

The product claim is one command in a fresh VM → this workspace, in this
folder, syncing:

```sh
# key comes from the environment; workspace by human-readable name
RBOX_KEY=… rbox setup --workspace=my-project        # into ./my-project (or --dir .)
RBOX_KEY=… rbox setup --workspace=my-project --daemon
```

Semantics of `rbox setup --workspace=<name>` when a key is present:

- **Headless-capable.** This path bypasses `setup`'s TTY gate
  (`setup-cmd.ts` hard-exits on non-TTY today): with `--workspace` + a key it
  runs fully non-interactive; without a key it errors with a pointer to the
  interactive flow rather than prompting.
- **Implicit materialize.** The bundle is unpacked to the standard keystore
  location (`~/.rbox` / `RBOX_HOME`) — no separate `rbox key materialize`
  step, no exported-vars dance. `materialize` remains as the porcelain for
  users who want the CI-style tmpdir containment (design 20 §5.3); `setup`
  calls the same internals.
- **Secret never on argv.** `--key` is a boolean-ish flag (reads `RBOX_KEY`
  from the env, which is also the default when the env var is set);
  `--key-file <path>` and `--key -` (stdin) exist for explicit plumbing. A
  literal `--key=<secret>` value is **rejected with an explanatory error**
  (design 20 R6 / M10 must-fix #4: argv leaks via `ps` and shell history).
- **Workspace by name.** `<name>` resolves against the account's workspace
  list: exact match on the workspace's display name or its slug (the
  human-readable identifier shown by `rbox status` / the dashboard). Zero
  matches → error listing available names; multiple → error demanding the id.
  Resolution needs one authed `GET` the key's route allowlist must include
  (workspace *list* is read-only; workspace *create* stays 403 for keys).
- **Lands in the folder you asked for.** Default: create `./<slug>/` under the
  CWD; `--dir <path>` (including `--dir .`) binds an explicit target. Refuses
  a non-empty target unless `--force` (same guardrails as design 44 — no
  silent merge into an existing tree).
- **First sync, then optionally the daemon.** After binding: one full pull. By
  default it exits after the pull (agents are one-shot by default; the tree is
  there). `--daemon` starts the background watcher exactly like interactive
  setup's final step — Brian's "begin syncing right after" flow — subject to
  the single-writer rule (§4.1a).

### 4.1a Daemon + shared keys (the writer rule, restated for this flow)

`--daemon` (without `--pull-only`) makes the VM a **writer**. Per §3, a key
that writes must not be shared: a fleet of N VMs sharing one `RBOX_KEY` may
all `setup --workspace=…` (pull) and run `--daemon --pull-only` freely; a
writing agent needs its own key. v1 enforcement is a **static warning** —
keyed `--daemon` prints the rule at startup. There is no reliable sibling
detection to build on (§9 R6): the server sees one shared, throttle-updated
token row, so any "someone else is using this key" heuristic would be theater.
Real per-VM identity is the `--fork` future work (§3).

### 4.2 The curl one-liner (the marketing artifact)

```sh
# in any fresh machine, with RBOX_KEY in the environment:
curl -fsSL https://rbox.to/agent.sh | sh -s -- --workspace=my-project
```

`agent.sh` = install (same TOFU posture as install.sh, design 14 U8) → exec
`rbox setup` with the passed flags. It is a thin wrapper over §4.1 — all logic
lives in the CLI so the script never drifts. Versioned in this repo alongside
install.sh; it is the artifact the homepage terminal demo shows.

### 4.3 Bundle format note

`RBOX_KEY` is design 20 §5.2's bundle unchanged, plus a `v` version field and a
`kind: "agent"` label (cosmetic; both CI and agent keys are the same
mechanism). Versioning exists so a future `--fork`-capable bundle (§3) can be
introduced without breaking baked secrets.

### 4.4 Pull-only ergonomics

Add `rbox sync --pull-only` and `rbox setup --daemon --pull-only` (design 20
R9 suggested the former; agents make both necessary): a long-lived sandbox
that should track upstream without ever pushing gets a watching pull loop,
which also sidesteps the single-writer rule entirely. The route allowlist
stays read-write in v1 (the key IS a full device); `--pull-only` is a
client-side convention, stated as such.

### 4.5 Dashboard

Design 20 §7's management view, plus one agent-relevant column: `last_seen_at`
rendered as "active Xm ago" — a fleet of VMs sharing a key shows as one row
with fresh last-seen, which is the correct mental model (one identity).

## 5. Plan gating (design 86 interaction)

Agent keys are a paid feature by construction: `plan = 'none'` (locked) refuses
`rbox key create-ci` (403 with the subscribe hint) — a trial or paid plan is
required. Key creation counts nothing against storage; the pulls/pushes the
key performs hit the same caps as any device. No per-plan key-count
differentiation in v1 (flat cap of 5); if Team lands with more agents-per-seat
demand, revisit.

## 6. What ships when

| Milestone | Contents |
|---|---|
| **87-v1 (beta)** | design 20 v1 (migration, recognizer, create-ci/materialize/revoke, route allowlist, web manage view) **with two named deltas** (§9 R1/R2): kind-based principal classification replacing the expires⇒web heuristic, and `GET /v1/account/workspaces` (list, read-only) added to the api_key allowlist for name resolution — plus §2 answers, keyed `rbox setup --workspace`, `agent.sh`, `--pull-only`, docs. Marketing line goes live with "beta" framing. |
| **P3 + design 19** | epoch rotation/re-wrap → real crypto-revocation → drop "beta". |
| **later** | scoped MK-less read-only transport (design 20 §6.5), `materialize --fork` per-VM identities (§3). |

## 7. Verification (agent-specific additions to design 20 §9)

- **One-command join:** clean container, `RBOX_KEY` env only,
  `rbox setup --workspace=<name>` → tree present in `./<slug>/`, exit 0,
  non-TTY. Name resolution: unknown name errors with the available list;
  ambiguous name demands the id. Literal `--key=<secret>` on argv → rejected.
- **Fleet e2e:** 3 clean containers, same `RBOX_KEY`, concurrent
  `rbox setup --workspace=<name>` → all three hold byte-identical trees;
  server shows one device, `last_seen_at` advancing.
- **agent.sh idempotence:** second run in the same VM is a fast no-op pull.
- **Daemon flow:** `setup --workspace=<name> --daemon` leaves a running
  watcher that picks up a change pushed from another (distinct-key) device;
  `--daemon --pull-only` never pushes a local mutation.
- **Plan gate:** `create-ci` on a `none`-plan account → 403 + subscribe hint.
- **Cap:** 6th outstanding key → 429; revoking one frees a slot.
- **Bake-ability:** `RBOX_KEY` minted, VM image built with it, image booted
  after 24h → pull works (no TTL surprise short of the key's own expiry).

Adversarial cases (§9 R8 — these matter more than the honest-path ones):

- **Allowlist denials with a real key:** an `api_key` bearer gets 403 on
  `billing/*`, `pair/create`, `device/approve`, workspace *create* — and 200
  on workspace *list* and the sync/key-sync routes. (The server-side
  allowlist is the only boundary that holds against a modified client; the
  honest-client `--pull-only` tests above prove convention, not security.)
- **Kind classification:** an expiring `api_key` principal reaches sync routes
  (the live expires⇒web heuristic would have denied it — regression-guard the
  replacement); a web-session token still cannot.
- **Same-identity concurrent push:** two clients, same bundle, racing pushes →
  head CAS resolves (one wins, one retries cleanly); then assert the fanout
  mis-attribution hazard is documented behavior, with a sibling puller on the
  shared identity demonstrably NOT receiving the writer's commit (the reason
  the §3 rule exists).
- **Cap race:** two concurrent `create-ci` calls at 4 outstanding keys → at
  most one succeeds (same race-safety bar as `mintDevice`'s durable cap).

## 8. Open questions

1. Should the homepage terminal demo change to show the agent flow, or does
   the agent story get its own landing section/page (`rbox.to/agents`)?
   (Marketing call, not blocking implementation.)
2. Does keyed `setup` also accept `--workspace=<id>` for fleets where names
   get renamed mid-flight? (Lean: yes — ids always work; names are sugar.)

## 9. Codex adversarial review (pass 1)

Codex (gpt-5.5, xhigh, read-only against the live tree) reviewed the first
draft and returned **VERDICT: FAIL** — 2 BLOCKER, 4 HIGH, 2 MEDIUM. All eight
were correct. This section is normative and the body above has been amended to
match.

- **R1 [BLOCKER] The cap-exemption free ride didn't exist.** The draft assumed
  `expires_at`-carrying keys ride the existing durable-count exclusion
  straight onto sync routes; live auth classifies every expiring token as
  `kind='web'` (`authenticate.ts:46`) and web principals are *denied* the
  crypto/sync routes (`worker.ts:245,255`). **Resolution:** §2 Q6 now names
  kind-based principal classification (design 20 §3's `devices.kind` + the
  `rbox_pat_` recognizer) as an explicit implementation prerequisite; §6
  carries it as a named delta.
- **R2 [BLOCKER] Workspace-name resolution contradicted "design 20 v1
  verbatim".** Design 20 R2's allowlist has no workspace-list route.
  **Resolution:** §6 drops "verbatim" and names the one-route extension
  (`GET /v1/account/workspaces`, read-only) as a delta; workspace *create*
  stays 403.
- **R3 [HIGH] The 5-key cap was specified against the wrong table.** The
  sidecar deliberately holds no `revoked`/`expires_at` (design 20 R10).
  **Resolution:** §2 Q6 counts `devices` rows (`kind='api_key' AND revoked=0
  AND expires_at > now`), race-safe like `mintDevice`.
- **R4 [HIGH] "Share this key freely" overstated pull-only sharing as a
  boundary.** Every bundle holder is account-root; `--pull-only` binds only
  honest clients. **Resolution:** §3 reframes sharing as a blast-radius
  decision and the creation warning says so.
- **R5 [HIGH] The concurrency rationale was factually wrong.** Sequencing is
  workspace-head CAS (`workspace-sync.ts:287,300`), not per-device; the real
  hazards are fanout/mirror metadata keyed by commit `deviceId`
  (`workspace-sync.ts:321,326`) and attribution collapse. **Resolution:** §3
  rewritten with the true mechanics; the rule tightens from "one live writer
  per key" to "a shared key is pull-only; writers get their own key".
- **R6 [HIGH] The `last_seen_at` sibling-detection heuristic was theater.**
  One shared, throttle-updated token row carries no per-VM signal.
  **Resolution:** §4.1a replaces it with a static startup warning and says
  why detection is not buildable.
- **R7 [MEDIUM] `--fork` cleanup hand-waved E2EE state.** Auth-row expiry
  retires nothing in the append-only roster / `device_keys`. **Resolution:**
  §3's future-work note now names epoch rotation (P3 → design 19) as the only real
  retirement of dead child identities.
- **R8 [MEDIUM] Verification tested the honest paths only.** **Resolution:**
  §7 gains the adversarial block (allowlist denials, kind classification,
  same-identity push race + fanout mis-attribution, cap race).
