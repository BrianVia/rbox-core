# Review 184 — One-shot pairing command

## Round 1 — adversarial review

**Result:** NEEDS REVISION

1. **BLOCKER — executable output trusted an unvalidated server string.** A
   custom or compromised remote could return shell metacharacters, newlines, or
   terminal escapes. Require the returned token to equal the locally requested
   `rbox-pair_${tokenId}` before display/copy and test hostile mismatches.
2. **HIGH — active guidance and superseded security rulings were incomplete.**
   Include README, init/setup guidance, active comments, learnings, and explicit
   supersession of design 10 resolution 4 and design 12 C11.
3. **HIGH — acceptance tests were underspecified.** Prove pair/connect arity,
   prompt bypass, retained TTY/stdin input, remote forwarding, exact clipboard
   payload, and durable credential + E2EE admission—not only success copy.

## Revision

Design 184 now defines an executable-output trust boundary with an exact
server-token equality check, enumerates every active surface and superseded
ruling, limits argv acceptance to short-lived pairing tokens, and makes the
dispatch/clipboard/durable-enrollment proof obligations explicit.

## Round 2

**Result:** PASS

The reviewer confirmed that exact server-token validation closes the executable
output boundary; the active surfaces and superseded no-argv rulings are covered;
and the acceptance criteria require meaningful dispatch, clipboard, credential,
E2EE-secret, and server-admission proof.

## Implementation review

**Result:** PASS after one copy correction

The reviewer found no correctness, injection-boundary, dispatch, arity, or
enrollment-proof issues. Three surfaces initially said the command copied
automatically; they now accurately say to press `c`. Focused CLI tests,
typechecks, guards, and durable credential/E2EE admission tests pass. The rig's
onboard scenario now executes the emitted `rbox connect <token>` argv path; live
execution remains for a machine with the two local dev rig secrets.
