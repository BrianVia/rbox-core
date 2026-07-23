# Onboarding feedback — first workspace and second machine

**Feedback date:** 2026-07-22

**Captured:** 2026-07-23

**Source:** Direct beta-tester conversation during a real two-machine setup

**Tester profile:** Frequent GitHub user, not a software developer

## Why this matters

The tester ultimately completed setup and sync, but only after asking for help at
three high-risk moments: recovery-phrase storage, second-machine pairing, and an
initial-sync filename collision. Each moment made a working system feel broken or
ambiguous. These are retention problems, not cosmetic polish: if a user cannot
confidently get a second machine online, the product's core value is not visible.

## Journey and observed friction

### 1. Creating the first workspace

The setup step said to create a workspace from a directory. The tester was not
sure whether this meant a generic workspace or something specifically managed by
rbox.

Suggested wording:

> Create a new rbox workspace from a directory.

### 2. Saving the recovery phrase

The 24-word recovery phrase was saved to macOS Keychain, but the flow did not
make it clear that the phrase could still be viewed and copied if Keychain were
declined. The tester found it afterward and stored it in their preferred password
manager.

The tester explicitly preferred 1Password over Keychain or a plaintext file.
They understood the need for client-side key generation once end-to-end
encryption was explained, but that explanation arrived in conversation rather
than in the product.

### 3. Pairing the second machine

`rbox pair` printed a raw token plus instructions to enter setup on the new
machine. The tester interpreted the output as a command, tried to run it, and got
a command-not-found error. Manually pasting the token into the pairing-token
prompt worked.

The tester also authenticated through the web UI on machine 2 but was still asked
to paste the token. They expected browser approval alone to complete the flow.
The product needs to make the distinction explicit:

- A pairing token authorizes the device **and** carries encryption enrollment.
- Browser/device-code approval authorizes the device but does not carry the
  encryption key.

The desired fast path is one complete command generated on machine 1 and executed
on machine 2, with no TUI detour:

```bash
rbox connect <pairing-token>
```

The token itself is intentionally omitted from this record.

### 4. Initial sync failed on case-only duplicate paths

The first sync failed with low-level Git and manifest diagnostics, ending with a
case-insensitive duplicate-path error. The directory contained both:

```text
_notes/Lucky Meat.md
_notes/Lucky meat.md
```

The files contained the same content. Removing one allowed sync to complete:

```text
pulled: 0 written, 0 deleted, 0 conflict(s)
pushed → sequence 3
```

The system correctly refused an unsafe cross-platform state, but the message did
not explain why one apparently minor file blocked setup, identify both sides of
the collision, or tell the user how to recover. macOS/Linux case behavior is an
implementation detail; the product must translate it into a concrete action.

### 5. Beta expansion

The tester asked to invite another non-developer GitHub user, Aaron, who could be
a useful promoter and feedback source. The invitation was approved, with a
request to establish a direct channel for occasional product feedback.

## Prioritized follow-ups

### P0 — unblock successful onboarding

- [ ] Make `rbox pair` print a complete `rbox connect <pairing-token>` command.
- [ ] Make `c` copy the complete command, not only the raw token.
- [ ] Ensure direct `rbox connect <pairing-token>` performs both authentication
  and encryption enrollment in one operation.
- [ ] Keep bare `rbox connect` and the guided `rbox` flow as equivalent fallback
  entry points.
- [ ] Test the clean two-machine path end to end: create, recoverability choice,
  pair, join an existing workspace, and converge.

**Status at capture:** Implemented and pushed separately on
`codex/one-shot-pairing` (`eaff0093b`), but not yet merged to `main`. Live rig
validation remains to be run from a machine with the dev rig secrets.

### P1 — make recovery and failure states understandable

- [ ] Change setup copy to “Create a new rbox workspace from a directory.”
- [ ] Explain why the recovery phrase exists: it creates the client-side key,
  cloud data is end-to-end encrypted, and rbox cannot recover the phrase.
- [ ] State clearly that the phrase can be viewed and copied before choosing a
  storage destination.
- [ ] Explain what happens when macOS Keychain storage is declined.
- [ ] Provide an obvious password-manager path, with 1Password-friendly copy.
- [ ] Detect case-insensitive duplicate paths before initial upload/sync.
- [ ] Name both colliding paths and explain the macOS/Linux portability issue.
- [ ] Tell the user to rename or remove one path and rerun `rbox sync`.
- [ ] Put the actionable duplicate-path cause before internal Git diagnostics.
- [ ] Hide `breadcrumb waiver vetoed`, `reason-local-edits`, and similar internal
  diagnostics behind verbose/debug output unless the user can act on them.

### P2 — prevent regressions and learn from the funnel

- [ ] Add coverage for generated pairing-command syntax and browser-vs-pairing
  enrollment behavior.
- [ ] Add cross-platform coverage for case-only duplicate paths and successful
  retry after resolution.
- [ ] Measure recovery-phrase storage choice, manual pairing-token fallback,
  initial-sync failure reason, and successful retry.
- [ ] Onboard Aaron and establish a lightweight recurring feedback channel for
  non-developer beta users.

## Product principles reinforced

1. **A technically correct refusal still needs a recovery path.** The duplicate
   filename guard protected data, but its presentation left the user stranded.
2. **Output that looks executable should be executable.** A raw bearer token in a
   terminal naturally reads like a command to a new user.
3. **Security explanations belong at the decision point.** Users are more willing
   to save a recovery phrase when they understand why rbox cannot recover it.
4. **The shortest path must expose the product's core value.** Second-machine
   pairing should reach authenticated, encryption-enrolled sync with one command.
5. **Design for the GitHub-capable non-developer.** Familiarity with GitHub does
   not imply familiarity with Git internals, shell credential semantics, or
   filesystem case rules.
