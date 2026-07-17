# TUI persona walkthrough audit — 2026-07-16

Design-135 harness run: 20 flows (5 personas × 8 scenarios) driving the real
TUI over tmux with codex personas. Outcomes: 9 completed, 8 abandoned at
genuine dead ends, 3 blocked at browser handoffs (harness protocol).
Raw per-flow transcripts remain with the 2026-07-16 session.



# BLOCKERS

## [2 P1×S2]
SCREEN: (after Enter on empty 'Workspace id to sync') -> tmux capture-pane failed (exit 1); child output suppressed
EXPECTED: Submitting an empty required field should show inline validation ('workspace id can't be empty') and re-prompt in place.
REALITY: The entire rbox setup process dies silently — confirmed via `tmux list-sessions` ("no server running") and `ps aux` showing zero rbox/bun processes left in the container. No error text, no explanation, reproduced twice independently on two separate sessions against the same enrolled HOME.

## [4 P1×S7]
SCREEN: ⚠  This directory already syncs to workspace ~ (ws_42fe6305b3bf4bad81c9e0cf3c964033).
? Create a brand-new workspace for it anyway? (files on disk are untouched; sync history starts fresh) (y/N)
EXPECTED: Pressing Enter (default N) declines creating a duplicate and proceeds to sync the already-registered workspace.
REALITY: Every attempt (2/2) crashed: the whole tmux server died (`no server running on /tmp/tmux-0/default`) with no error text ever shown on screen. Re-running `rbox setup` on the same dir a third time from scratch reproduced identical state, confirming it wasn't a fluke.

## [4 P1×S7]
SCREEN: ✔ Pick an existing workspace to sync ~ · created 1m ago · never synced · ws_42fe6305
? Which directory should rbox sync? (/tmp/rbox-ux/flow4run/solo)
EXPECTED: Confirming the default directory for the already-picked existing workspace would proceed to the gitignore/ignore step.
REALITY: Same silent crash: tmux server died before the next prompt ever rendered. This is the "Sync an existing workspace" branch — a completely different code path from the y/N prompt above — yet it crashes identically on the same directory, suggesting the bug is in whatever validates/re-registers an already-synced directory, not in one specific prompt.

## [5 P2×S1]
SCREEN: To authorize this device, visit:

    /cli-login?code=93AU-LD5Z

    (or run `rbox device approve 93AU-LD5Z` on an already-signed-in machine)
EXPECTED: The primary authorize-this-device instruction would be a complete, followable URL (scheme + host + path) I could type into any browser, on any device.
REALITY: The 'visit' target is a bare relative path with no scheme or host at all. Taken literally, it is not something a browser can navigate to. The only other option offered requires an already-signed-in second machine, which a first-machine/genesis user by definition does not have.

## [5 P2×S1]
SCREEN: ? Open the approval page?
❯ Open in browser
  Copy URL to clipboard
  I'll approve it another way
EXPECTED: Selecting 'I'll approve it another way' would surface an alternate path for someone without a usable browser on this machine — e.g. the full URL to relay to another device, a short code to read aloud,
REALITY: After selecting it, the screen shows no new text whatsoever. It reverts to the same 'Waiting for approval (expires in 600s)...' block with the same unusable bare path above it, and silently polls with no further guidance. A user with no browser access is stuck with nothing actionable.

## [7 P2×S4]
SCREEN: ── Step 1 of 2 · Workspace ────────────────────────────────────────────
✔ Workspace name (Enter accepts, "-" for none) proj
? How should rbox handle gitignored files?
❯ Skip gitignored untracked files
EXPECTED: Confirming the recommended gitignore default (Enter) advances to the next step of the wizard, as every prior prompt had.
REALITY: The entire TUI process dies right after this confirmation — reproduced twice independently (once linking the original ~/proj workspace, once with a brand-new ~/proj2 directory + brand-new workspace). `wait-idle`/`screen` return 'tmux capture-pane failed' permanently afterward (confirmed with 3 separate official harness calls, not a transient blip). Re-running `rbox setup` afterward shows the direc

## [7 P2×S4]
SCREEN: ✔ Which directory should rbox sync? proj
✓ workspace ws_365fe8e9c686432bb0a137b65037e6a2
this workspace is end-to-end encrypted — the server never sees your file names or contents.
synced: 0 pulled, 0
EXPECTED: Since this is machine b picking up the 'proj' workspace that a supposedly already has content in, I expected some files to be pulled down (or at minimum a note that there's currently nothing to pull b
REALITY: '0 pulled, 0 conflict(s)' is presented as a plain, successful-looking status line with no severity marker, and setup proceeds straight to the final 'Start syncing' step as if everything worked. A cautious reader who reads every word would parse 'synced: 0 pulled' as 'nothing new to sync, all caught up' — not as 'the folder you were told already syncs from a is actually empty here.' Checking the re

## [8 P2×S6]
SCREEN: ? How do you want to authorize this machine?
❯ Paste a pairing token
  Sign in via browser
  Approve a code
EXPECTED: Having answered 'I already have an rbox account' (the literal fit for someone recovering a lost machine with a seed phrase), I expected one of these three authorize-methods to be, or lead to, a 24-wor
REALITY: None of the three options mention a recovery phrase. 'Paste a pairing token' is a masked token field with no alternate mode. 'Sign in via browser' and 'Approve a code' both resolve to the identical device-code wait screen with no phrase-entry fallback, even via their 'I'll approve it another way' sub-choice.

## [8 P2×S6]
SCREEN: Waiting for approval (expires in 600s)...
✔ Open the approval page? I'll approve it another way
EXPECTED: Expected 'I'll approve it another way' to open an alternate input method (e.g., a phrase, a manual code, a different login mode).
REALITY: Selecting it just re-confirms the choice and leaves the screen in the exact same 'Waiting for approval' state, still tied to the same device code with no other input option. For a user with only one machine (this scenario), it is a genuine dead end -- there is no second device to run `rbox device approve` from.

## [11 P3×S4]
SCREEN: ? Which directory should rbox sync? (/tmp/rbox-ux/flow11/a)
EXPECTED: Typing the single most natural Unix answer, "~/proj", would resolve to the user's actual project folder at $HOME/proj, since the default shown is the absolute HOME path and the prompt clearly wants a 
REALITY: rbox took the string literally and created a real directory named "~" inside HOME, then bound the workspace to "~/proj" under that literal folder (empty, only a .rbox marker) instead of expanding to $HOME/proj. The real ~/proj (3 files) was never touched. No warning, no path confirmation, no error — the wizard proceeded to "✓ workspace ..." and "already in sync — nothing to upload" as if it had su

## [11 P3×S4]
SCREEN: device authorized + encryption enrolled: dev_b7e85647679f312d061df028bbb68a5b
Run `rbox setup` and choose "Sync an existing workspace" to get your existing folder syncing here.
EXPECTED: This next-step guidance is genuinely excellent and exactly what P3-Ryan needs — I expected the rest of the flow (workspace picker showing the right workspace by name) to actually finish the job of get
REALITY: The guidance and the picker both worked perfectly, but the flow still terminates on the same tilde-expansion bug at the directory prompt, so the excellent signposting doesn't actually deliver Ryan to his goal. The good UX design (design-134's next-step chain) is undermined by a lower-level path-handling defect at the very last step.

## [13 P4×S1]
SCREEN: To authorize this device, visit:

    /[path]?code=[REDACTED]

    (or run `rbox device approve [REDACTED]` on an already-signed-in machine)
EXPECTED: A fully-qualified URL (scheme + host) so I can verify the destination domain before trusting it with a device-authorization code — a secops user will not visit an unqualified path.
REALITY: The printed 'visit' target is a bare path with no scheme or host anywhere on screen. Nothing else on the terminal names the domain the code will be redeemed against.

## [13 P4×S1]
SCREEN: ? Open the approval page?
❯ Open in browser
  Copy URL to clipboard
  I'll approve it another way
EXPECTED: Choosing "I'll approve it another way" should reveal an actual alternate path (a code to relay elsewhere, a QR code, a note that says exactly what to do without a browser) since I explicitly declined 
REALITY: Selecting it just marks the question answered and falls back to the same 'Waiting for approval... visit /[path]?code=... or run `rbox device approve <code>` on an already-signed-in machine' text already on screen. A genuinely first-machine, browser-less user has no already-signed-in machine to run that command on and no domain to visit manually (e.g., by copying to a phone). This is a real dead en

## [15 P4×S6]
SCREEN: ? How do you want to authorize this machine?
❯ Paste a pairing token
  Sign in via browser
  Approve a code
EXPECTED: As a user with no second device (the only realistic reason to need 24-word recovery), I expected a 'Recover with my 24-word phrase' choice alongside the other three auth methods.
REALITY: Only three items exist, confirmed by cycling Down through all of them and observing the cursor wrap back to the top. No fourth item, no scroll indicator, no hidden option.

## [15 P4×S6]
SCREEN: ? Press Enter to sign up in your browser (advanced: enter an account bootstrap secret) [input is masked]
EXPECTED: If recovery isn't under 'Log into an existing account', I expected it might be folded into 'Create a new account' as a 'no wait, restore instead' alternative.
REALITY: This branch only offers browser signup or an 'account bootstrap secret' (masked input) — a different concept from a 24-word recovery phrase, reads like a dev/admin escape hatch rather than a lost-device user recovery path.

## [16 P5×S1]
SCREEN: To authorize this device, visit:

    /cli-login?code=X9ZY-ZTJQ
EXPECTED: A full absolute URL (https://... ) I could type into any browser, on any machine, to approve the device.
REALITY: The printed 'visit' target is a bare relative path with no scheme or host: "/cli-login?code=...". As literal terminal text this is not visitable in a browser — there is no domain to prepend, and nothing on screen states what host it belongs to (app.rbox.to? rbox.to? something else?). A user who copies exactly what's shown is stuck.

## [18 P5×S5]
SCREEN: ? Which directory should rbox sync? (/tmp/rbox-ux/18/solo)
EXPECTED: Typing a nonexistent/typo'd directory name ("myproect" instead of "myproject") would be rejected with a "no such directory" error and let me retype.
REALITY: The wizard silently accepted the typo, moved on to the workspace-name step (pre-filled with the same typo), then silently created a brand-new empty directory on disk (/tmp/rbox-ux/18/solo/myproect containing only an .rbox/ state dir) and a real server-side workspace (ws_442decae7e1947c39c2976f063870925) for it — reporting "✓ already in sync — nothing to upload" as if this were a success.

## [18 P5×S5]
SCREEN: ✗ rbox: Workspace limit reached — plan allows 1. Upgrade with `rbox subscribe solo` for unlimited workspaces.
EXPECTED: That fixing my typo and re-running `rbox setup` against the correct directory would create the workspace I actually wanted.
REALITY: The phantom typo'd workspace permanently consumed the account's only allowed workspace slot (solo plan = 1). Every subsequent clean attempt against the real "myproject" repo failed with this quota error. There is no path shown to delete/free the phantom workspace — only "upgrade your plan." The tmux pane also closed almost immediately after printing this error on two of three attempts, making it l

## [19 P5×S8]
SCREEN: ? Paste pairing token [input is masked]  ->  (Enter)  ->  tmux capture-pane failed (exit 1); child output suppressed
EXPECTED: As a fumbler who just pasted a malformed/wrong/truncated pairing token into the interactive `rbox setup` wizard, I expected either a validation error naming the problem (mirroring what `rbox connect` 
REALITY: The `rbox setup` process crashed outright on every malformed-token variant tested (whitespace-padded, plain garbage, shape-valid-but-fake, truncated) - the pane and even the underlying tmux server died with zero on-screen error text at any point. Verified via `docker exec ... ps aux | grep rbox` (no process) and `tmux list-sessions` (no server) that this is the app terminating, not a harness/docke


# MAJORS

## [1 P1×S1]
SCREEN: To authorize this device, visit:

    /cli-login?code=WHRX-LU7S

EXPECTED: A copy-pasteable, fully-qualified URL (scheme + host) that a fast-typing CLI user can paste straight into a browser address bar or use with curl.
REALITY: The printed line is a bare relative path with no scheme or host, so pasting it verbatim into a browser does nothing useful. This may be an artifact of the harness's RBOX_APP env var being intentionally blanked for safety (WALKTHROUGH.md: "RBOX_APP is blanked so a DEV login cannot direct the agent into the production dashboard"), so it may not reproduce outside this harness — flagging for synthesis

## [2 P1×S2]
SCREEN: ── Step 2 of 3 · Workspace ──
✔ What do you want to track here? Sync an existing workspace
? Workspace id to sync
EXPECTED: Either a list of known workspace ids for the already-resolved account, an example id format, or a pointer like 'find this with `rbox list` on your other machine' — every prior prompt in this same wiza
REALITY: Bare blank input, no help text at all, no listing, no format example, despite the account already being known server-side.

## [2 P1×S2]
SCREEN: DEAD-END: Step 2 of 3 (or Step 1 of 2 on resume) · Workspace → 'Sync an existing workspace' → 'Workspace id to sync' prompt, submitted empty
EXPECTED: 
REALITY: Required-field validation. Pressing Enter with nothing typed terminates the entire rbox setup process and kills the terminal session/pane with it, leaving no error message and no indication that pairing/enrollment survived (it does, confirmed by restart, but nothing on screen says so).

## [3 P1×S5]
SCREEN: DEAD-END: Immediately after pressing Enter on the gitignore choice (both on the first full run and on a second attempt after declining a y/N re-create prompt)
EXPECTED: 
REALITY: The tmux session -- and the whole tmux server inside the container -- died the instant the `rbox setup` process exited, so `wait-idle`/`screen` failed with 'no server running on /tmp/tmux-0/default'. Could not observe the actual Step 2 of 2 screen or any completion/summary message through the TUI harness; had to fall back to a direct `rbox status` / `rbox ignore --list` docker-exec check to confir

## [4 P1×S7]
SCREEN: (entire pane goes blank; only `tmux capture-pane failed (exit 1); child output suppressed` is returned)
EXPECTED: If `rbox setup` hits an internal error, it prints something — a stack trace, an error banner, anything a user could screenshot or paste into a bug report.
REALITY: Zero diagnostic output. The process (and its tmux pane) just vanishes. A real user would have no idea what happened or what to search for.

## [4 P1×S7]
SCREEN: DEAD-END: `rbox setup` re-run against a directory that already synced to a workspace (both the "create brand-new anyway? y/N" prompt and the "sync an existing workspace → confirm directory" prompt)
EXPECTED: 
REALITY: Any error message, retry option, or recovery path. The whole tmux server dies, so from a real terminal the user's shell session itself would be gone. No hint that the workaround (using the raw `rbox ignore` commands directly instead of the wizard) exists or is even necessary.

## [5 P2×S1]
SCREEN: DEAD-END: Device-authorization screen, after choosing 'I'll approve it another way'
EXPECTED: 
REALITY: Any alternate instructions for a user without browser access on this machine — e.g. a full copyable URL, a short code to relay verbally/via chat to someone else, or QR code guidance. The screen just resumes silent polling.

## [6 P2×S3]
SCREEN: To authorize this device, visit:

    /cli-login?code=XXXX-XXXX
EXPECTED: A 'visit this address' instruction should be a complete, launchable URL (scheme + host), since the whole point of this step is to send the user somewhere outside the terminal.
REALITY: The printed line is a bare path (`/cli-login?code=...`) with no scheme or host. Read literally — which is exactly what this persona does — it is not a URL you can 'visit' from a terminal-only context. A user with no local browser (e.g. SSH'd into a headless box) cannot reconstruct the real address from this text alone; they'd have to already know or guess the rbox web app's domain.

## [7 P2×S4]
SCREEN: DEAD-END: Machine a, `rbox setup` → Create a new workspace from a directory → proj → (accept name) → accept gitignore default → [process dies]
EXPECTED: 
REALITY: No error message, no crash report, no partial-progress indicator. The wizard simply stops responding; re-running `rbox setup` shows the directory as untracked again, with a server-side workspace record ('proj · never synced') orphaned and unreachable through the normal wizard (selecting it just re-runs the same directory prompt into the same crash).

## [7 P2×S4]
SCREEN: DEAD-END: Machine a, retry via 'Sync an existing workspace' → proj → typed both relative ("proj") and absolute ("/tmp/rbox-ux/flow7/a/proj") paths at the 'Which directory should rbox sync?' prompt
EXPECTED: 
REALITY: Both inputs crash identically at the exact same point (after Enter, before any progress line appears) — confirms this isn't a path-format edge case, it's a general failure to push actual file content on first link.

## [7 P2×S4]
SCREEN: DEAD-END: Harness limitation, not a product bug: `tui.ts start --home` requires the path to be exactly `/tmp/rbox-ux/<run-id>/<name>` — it refused `/tmp/rbox-ux/flow7/a/proj` with 'machine HOME must b
EXPECTED: 
REALITY: Could not test the realistic case of a user `cd`-ing into ~/proj and running `rbox` from inside it; had to run everything from the machine's fixed HOME and type the relative subdirectory name into prompts instead. This is a harness constraint, not a product finding.

## [8 P2×S6]
SCREEN: ✔ Are you new here, or do you already have an rbox account? Create a new account
? Press Enter to sign up in your browser (advanced: enter an account bootstrap secret) [input is masked]
EXPECTED: Checked this branch too, in case recovery is filed under 'new account setup on a fresh device' rather than 'login'.
REALITY: Goes straight to browser signup or an 'account bootstrap secret' field -- a different concept from a recovery phrase, and not it either.

## [8 P2×S6]
SCREEN: ✔ How do you want to authorize this machine? Sign in via browser

To authorize this device, visit:

    /cli-login?code=[REDACTED]
... (same structure repeats verbatim under 'Approve a code')
EXPECTED: Expected 'Sign in via browser' and 'Approve a code' to be two distinct mechanisms, since they are presented as separate menu items with different labels.
REALITY: Both produce byte-for-byte the same screen template and the same wait-for-remote-approval behavior. A careful reader who compares them side by side finds no functional difference, which undermines confidence that the menu was designed/read carefully.

## [8 P2×S6]
SCREEN: DEAD-END: `rbox setup` -> Log into an existing account -> (any of the three authorize methods)
EXPECTED: 
REALITY: A way to enter a 24-word recovery phrase. This scenario (S6) could not be executed at all because the entry point does not exist anywhere in the setup wizard's Step 1, as far as could be discovered by reading every screen and trying every menu leaf without guessing or reading source/docs.

## [8 P2×S6]
SCREEN: DEAD-END: 'Sign in via browser' / 'Approve a code' -> 'I'll approve it another way'
EXPECTED: 
REALITY: Any alternate input path. It silently just keeps waiting on the same device code, with no indication that this sub-choice does not actually change anything, leaving a single-machine user stuck with no way forward except letting the 600s window expire.

## [9 P3×S2]
SCREEN: device authorized + encryption enrolled: dev_79a17b13bac7d3b87d91a6615599847b
Run `rbox setup` and choose "Sync an existing workspace" to get your existing folder syncing here.

── Step 2 of 3 · Works
EXPECTED: As second-device Ryan who half-remembers the pairing flow, I read 'Run `rbox setup` and choose Sync an existing workspace' as an instruction for something I do AFTER this wizard finishes -- i.e. quit,
REALITY: I was already inside the same `rbox setup` invocation, already on the exact Step 2 screen showing 'Sync an existing workspace' as a live selectable option one line below the instruction telling me to run it. The confirmation line duplicates/contradicts the wizard's own next step instead of just letting the wizard continue.

## [9 P3×S2]
SCREEN: DEAD-END: Step 2 of 3 · Workspace prompt, pressed Ctrl-C to back out after judging the enrollment/next-step copy
EXPECTED: 
REALITY: The harness's tmux session terminated outright (`tmux capture-pane failed (exit 1)`) instead of showing whatever cancel/exit message the wizard itself prints on Ctrl-C, so I could not observe the product's actual interrupt-handling copy. This reads as a harness artifact (the pane's sole foreground process exiting closes the session) rather than a product defect, but it blocked judging that recover

## [10 P3×S3]
SCREEN: To authorize this device, visit:

    /cli-login?code=KE5B-VTPM

    (or run `rbox device approve KE5B-VTPM` on an already-signed-in machine)
EXPECTED: As a terminal-only user on a second machine, I expect a complete, absolute URL I could type into any browser (on this machine, my phone, or elsewhere) — e.g. https://app.rbox.to/cli-login?code=KE5B-VT
REALITY: The printed 'visit' target is a bare relative path with no scheme or host: `/cli-login?code=KE5B-VTPM`. It is unusable outside the CLI's own 'Open in browser' action. If Ryan is SSH'd into this second machine (headless, no local browser to auto-launch) and wants to hand the link to a browser on his phone or laptop, this line gives him nothing to type or paste — he has to guess the domain.

## [11 P3×S4]
SCREEN: ✓ already in sync — nothing to upload (sequence 0)
rbox push files=0 blobs=0 ct=0B wire=0B changed=0B
EXPECTED: Since I had just pointed rbox at a folder with 3 real files, I'd expect the first push to show files=3 or at least some non-zero count, or a warning that the target directory is empty.
REALITY: The screen reports success with files=0, which reads exactly like a normal 'nothing new to sync' message and gives no signal that the bound directory is wrong or empty. A user with no independent way to check file counts would have no reason to doubt this.

## [11 P3×S4]
SCREEN: DEAD-END: Machine b, end of setup wizard: "synced: 0 pulled, 0 conflict(s) -> sequence 0" followed immediately by Step 3 "Keep this workspace syncing in the background?"
EXPECTED: 
REALITY: No check that the joined workspace actually matches expected content, and no way from inside the TUI to notice or recover from the wrong-directory binding. A user who trusts the wizard (as instructed by the pairing screen's own guidance) walks away believing sync is set up, with zero on-screen indication that their real ~/proj is untouched.

## [12 P3×S7]
SCREEN: [.gitignore ACTIVE] node_modules/
  [.gitignore ACTIVE] dist/
  [.gitignore ACTIVE] .env
  [.gitignore ACTIVE] *.log
  [.rboxignore] *.bak
EXPECTED: After `rbox ignore '*.bak'` told me the rule was already stopping sync for matches (forward-only, effective immediately), I expected the re-listed rule to look at least as 'enforced' as the .gitignore
REALITY: Only .gitignore-derived rules ever carry an explicit ACTIVE tag; both [builtin] and [.rboxignore] rules are always shown bare, with no state word at all, even though all three categories are simultaneously enforced when respectGitignore is on. The ACTIVE tag is really signaling 'this specific rule source is subject to the respectGitignore toggle,' not 'this rule is currently in force' -- but that 

## [12 P3×S7]
SCREEN: DEAD-END: tui.ts session after selecting the gitignore-handling step (final wizard confirmation) and again after starting a fresh session to run `rbox status` via tui.ts
EXPECTED: 
REALITY: tmux capture-pane failed with 'no server running' both times -- fast-exiting, non-interactive rbox invocations (setup's final step, and `rbox status`) tear down the tmux session/server before wait-idle+screen can capture a frame. Not a product bug; a harness timing gap for quick commands. Worked around by using the printed docker-exec prefix directly for `rbox status`, `rbox ignore --list`, etc., 

## [13 P4×S1]
SCREEN: ◆  Welcome to rbox — end-to-end encrypted sync for your dev workspaces.
EXPECTED: As a skeptical secops user, before being walked into account creation I want some substantiation of the 'end-to-end encrypted' claim — even a single line pointing at what's encrypted, where keys are g
REALITY: The tagline is asserted once at the very top and never elaborated anywhere in the three screens reached (account choice, signup method, device-code approval). No mention of key custody, what data leaves the machine, or a security doc.

## [13 P4×S1]
SCREEN: DEAD-END: Device-code approval screen, option 'I'll approve it another way' (Step 1 of 3 · Account, after choosing 'Create a new account' → 'Press Enter to sign up in your browser')
EXPECTED: 
REALITY: Any actual non-browser path for a first machine. The two things offered instead — a bare unqualified URL to 'visit', and a command that requires an already-signed-in machine — are both unusable by a lone, browser-less, first-time user, which is exactly this scenario's condition.

## [14 P4×S2]
SCREEN: device authorized + encryption enrolled: dev_[REDACTED-ID]
Run `rbox setup` and choose "Sync an existing workspace" to get your existing folder syncing here.

── Step 2 of 3 · Workspace ──
? What do y
EXPECTED: After enrollment succeeds, the next-step instruction should tell me what to do from here — either 'you're done, sync happens automatically' or a next action I actually need to take outside the current
REALITY: The tool tells me to 'Run `rbox setup` and choose "Sync an existing workspace"' — but the very next thing the same wizard does, in the same invocation, is present Step 2 of 3 asking exactly that question with 'Sync an existing workspace' as one of the two options. The instruction reads as if I need to exit and re-invoke a command I am still inside. It looks like copy written for a different code p

## [15 P4×S6]
SCREEN: ? Paste pairing token [input is masked]
EXPECTED: Pressing Escape should back out one step to the previous menu (the auth-method chooser), consistent with 'retreat without starting over.'
REALITY: Escape had zero effect — screen was pixel-identical before and after, tested twice with wait-idle between. Same result on the separate bootstrap-secret masked input on the other branch.

## [15 P4×S6]
SCREEN: tmux capture-pane failed (exit 1); child output suppressed
EXPECTED: Ctrl-C should cancel the current sub-step and return to a prior menu, or at minimum show a clean 'cancelled' message before exiting.
REALITY: Ctrl-C killed the entire tmux pane/process outright — no cancellation message captured, no return to any menu. The only way back to setup is to run `rbox setup` again from scratch.

## [15 P4×S6]
SCREEN: DEAD-END: rbox setup -> Are you new here? -> Log into an existing account -> How do you want to authorize this machine? (3-item menu: Paste a pairing token / Sign in via browser / Approve a code)
EXPECTED: 
REALITY: No 'recover with 24-word phrase' option, and no acknowledgment anywhere in this menu or its hint text that a user without a second device has any path forward.

## [15 P4×S6]
SCREEN: DEAD-END: Paste pairing token screen (masked input) and the account-bootstrap-secret screen (masked input) on the other branch
EXPECTED: 
REALITY: A working Escape/back affordance. Escape is a listed, valid harness key but produced no visible change on either masked-input screen; Ctrl-C was the only interrupt and it terminated the whole process rather than stepping back one level.

## [16 P5×S1]
SCREEN: ? Press Enter to sign up in your browser (advanced: enter an account bootstrap secret) [input is masked]
EXPECTED: Typing a garbage/mistyped string into the masked field and pressing Enter would show an inline validation error (e.g. "invalid bootstrap secret, try again") so a fumbler could retry.
REALITY: Submitting a bogus string caused the session to end in a way that made the terminal uncapturable by the harness (tmux pane gone). Could not confirm whether the CLI actually handled this gracefully with an error message, or crashed outright — but from the user's chair, a masked field with zero visible feedback and an abrupt-looking exit is indistinguishable from a crash.

## [16 P5×S1]
SCREEN: ❯ Paste a pairing token
  Sign in via browser
  Approve a code

run `rbox pair` in a terminal on an already-set-up machine ...
↑↓ navigate • ⏎ select
EXPECTED: Pressing Escape after fumbling into the wrong Step-1 branch ("Log into an existing account" when I actually have no account) would step back to Step 1 so I could correct my choice.
REALITY: Escape did nothing at all — screen was byte-for-byte identical before and after. The only way out was to kill the whole process (Ctrl-C) and re-run `rbox setup` from scratch.

## [16 P5×S1]
SCREEN: DEAD-END: Step 1 sub-menu "How do you want to authorize this machine?" (reached via the wrong first choice)
EXPECTED: 
REALITY: A documented or working back-navigation (Escape, Left, or a "go back" menu item) to return to the previous step without killing the whole process.

## [16 P5×S1]
SCREEN: DEAD-END: Masked bootstrap-secret entry on the "Press Enter to sign up in your browser..." prompt
EXPECTED: 
REALITY: Inline validation/error feedback for a bad secret; instead the session became uncapturable by the harness, which is consistent with either a silent crash or an exit whose error text scrolled past before/without a stable prompt to re-capture.

## [17 P5×S2]
SCREEN: device authorized + encryption enrolled: dev_7ab342336f4ecaf1b1e245f936bcfe6d
Run `rbox setup` and choose "Sync an existing workspace" to get your existing folder syncing here.

── Step 2 of 3 · Works
EXPECTED: Post-enrollment guidance should be relevant to what happens next in THIS wizard run.
REALITY: The wizard tells the user to re-run `rbox setup` and choose 'Sync an existing workspace' — but the user is already inside that same `rbox setup` run, and the very next line of the same screen (Step 2) offers exactly that choice. Reads like a copy/paste leftover from a different context (e.g. plain `rbox pair`), not screen-aware messaging.

## [17 P5×S2]
SCREEN: Signed in and enrolled (acct_bd067517b13a8c97) — skipping account setup.

── Step 1 of 2 · Workspace ──
? What do you want to track here?
❯ Create a new workspace from a directory
  Sync an existing w
EXPECTED: Re-running `rbox setup` after a workspace already exists for the current directory should either skip that step, or warn that this directory is already tracked.
REALITY: Setup correctly skips the already-completed account step, but silently re-offers 'Create a new workspace from a directory' for the exact directory `rbox status` had already confirmed as a tracked workspace (ws_85e18ecb) — no warning of a possible duplicate.

## [17 P5×S2]
SCREEN: (final step of setup: gitignore-handling selection, then wizard exit)
EXPECTED: After the last wizard step, a confirmation/summary screen ('you're all set — run X') should remain visible before the process exits.
REALITY: The tmux pane closed immediately after the last Enter — `wait-idle` and `screen` both failed with 'tmux capture-pane failed (exit 1)', so no final wizard confirmation screen was observable at all; the terminal just returns to a shell prompt. Had to run `rbox status` separately to learn the workspace was created and to find the 'run `rbox start`' next-step guidance.

## [17 P5×S2]
SCREEN: DEAD-END: Final gitignore-handling step of `rbox setup` (Step 2 of 3, machine b)
EXPECTED: 
REALITY: The wizard's own completion/confirmation screen was never observable — the tmux pane closed before `wait-idle`/`screen` could capture it, so the actual final copy the wizard shows (if any) before exiting is unknown from this run. Substituted with `rbox status` output, which is a real but indirect substitute.

## [18 P5×S5]
SCREEN: ? Workspace id to sync  (after Escape was pressed)
EXPECTED: Escape backs up one step to the previous menu (Create vs Sync a workspace), letting me correct my wrong menu choice.
REALITY: Screen was completely unchanged after Escape — no visible feedback that anything happened. No way to back out of the wrong path except abandoning entirely.

## [18 P5×S5]
SCREEN: DEAD-END: "Which directory should rbox sync?" prompt, after typing a typo'd/nonexistent path
EXPECTED: 
REALITY: Any existence check on the entered path before proceeding — no error, no "did you mean myproject?" suggestion, no confirmation step before it creates a new directory and a real server-side workspace.

## [18 P5×S5]
SCREEN: DEAD-END: "Workspace limit reached" error state
EXPECTED: 
REALITY: No in-wizard way to list, identify, or delete the offending phantom workspace to reclaim the quota slot; no cross-reference back to the typo that caused it.

## [18 P5×S5]
SCREEN: DEAD-END: "Workspace id to sync" prompt (wrong menu path)
EXPECTED: 
REALITY: No working Escape/back action to return to the previous menu step; only a destructive Ctrl-C that kills the whole session.

## [19 P5×S8]
SCREEN: DEAD-END: `rbox setup` -> Log into an existing account -> Paste a pairing token -> (submit any malformed token)
EXPECTED: 
REALITY: Any error message, retry option, or graceful failure at all. The process exits/crashes silently, dropping the user to a dead pane with no indication of what happened or what to do next. They must notice the terminal is unresponsive, kill it, and manually re-run `rbox setup` from scratch, re-answering the two prior wizard questions.

## [20 P5×S8b]
SCREEN: ? Press Enter to sign up in your browser (advanced: enter an account bootstrap secret) [input is masked]
EXPECTED: As a fumbler pasting a plausible-but-wrong bootstrap secret ("not-a-real-secret-xyz   " with trailing whitespace), I expected an inline validation error and a re-prompt on the same field, the way most
REALITY: Submitting any non-empty text here terminates the whole `rbox setup` process immediately — confirmed twice on independent fresh sessions. The tmux session ends in the same tick as the keystroke (capture-pane fails even with zero added delay), so no error text is visible; the user is simply dropped back to a shell prompt and must re-run `rbox setup` from Step 1.

## [20 P5×S8b]
SCREEN: ? Paste pairing token [input is masked]
EXPECTED: Pressing Enter on this field with nothing typed should be refused with something like "token required" and re-prompt, since this is the field most likely to catch a literal fumble (empty paste, wrong 
REALITY: Pressing Enter with an empty pairing-token field also terminates the whole process instantly, identical to the bootstrap-secret case above. No visible feedback; full wizard restart required.

## [20 P5×S8b]
SCREEN: DEAD-END: Masked bootstrap-secret prompt: "Press Enter to sign up in your browser (advanced: enter an account bootstrap secret) [input is masked]"
EXPECTED: 
REALITY: Any captured error or cancellation text after submitting a nonsense secret. Tried on two independent fresh sessions; both times the tmux pane was already gone by the time `screen` was called, even with no wait-idle delay.

## [20 P5×S8b]
SCREEN: DEAD-END: Masked pairing-token prompt: "Paste pairing token [input is masked]"
EXPECTED: 
REALITY: Any captured validation message after submitting an empty field. Same instant-death pattern as above; only one clean attempt was needed to reproduce, matching the bootstrap-secret case exactly.

## [20 P5×S8b]
SCREEN: DEAD-END: All three Ctrl-C points (Step 1 account-type menu, "How do you want to authorize this machine?" menu, "Approve a code" open-approval-page menu)
EXPECTED: 
REALITY: Any captured "setup cancelled"/interrupt acknowledgment. capture-pane failed 3/3 times immediately after C-c, meaning the tmux session ends the instant the child process exits — there is no persistent shell left in the pane to show scrollback the way a real interactive terminal would.


# MINORS

## [1 P1×S1]
SCREEN: ? Press Enter to sign up in your browser (advanced: enter an account bootstrap secret) [input is masked]
EXPECTED: A single clear instruction for the common case (press Enter to open browser), with the advanced masked-secret path visually separated or reached via a flag/menu rather than crammed into one masked pro
REALITY: One line does double duty as both a plain continue-prompt and a masked secret-entry field, so a fast skim briefly raises "do I need a secret I don't have?" before the user commits to just pressing Enter.

## [2 P1×S2]
SCREEN: device authorized + encryption enrolled: dev_b2198bd4d75af2a55a9284ebf9a4b334
Run `rbox setup` and choose "Sync an existing workspace" to get your existing folder syncing here.

── Step 2 of 3 · Works
EXPECTED: After enrollment finishes, the next-step text should describe what the very next on-screen prompt is about to ask, not tell me to rerun a command I'm already mid-way through.
REALITY: The guidance literally says 'Run `rbox setup` and choose...' while I am still inside the same `rbox setup` invocation, one line above the exact menu it's describing. Reads like stale copy written for an out-of-wizard `rbox pair` completion, reused verbatim for the in-wizard path without adjusting the phrasing.

## [3 P1×S5]
SCREEN: ? How should rbox handle gitignored files?
❯ Skip gitignored untracked files (recommended)
  Sync gitignored files too (end-to-end encrypted)

re-include specific files with ! lines in .rboxignore (e.
EXPECTED: Picking 'Sync gitignored files too' would mean ALL gitignored content, including .env, gets synced (encrypted) since that's literally what the option says.
REALITY: Verified via `rbox ignore --list` after setup: .env is separately covered by ~15 hardcoded [builtin] secret patterns (.env, .env.*, *.pem, *.key, id_rsa, id_ed25519, *.sqlite, etc.) that apply regardless of the gitignore toggle. So choosing 'Sync gitignored files too' would NOT actually sync .env -- the setup screen never discloses this. As Max skimming, I'd walk away with a wrong mental model of 

## [3 P1×S5]
SCREEN: re-include specific files with ! lines in .rboxignore (e.g. !.env)
EXPECTED: This hint line implies .env is being excluded purely by the .gitignore-derived rule I just chose, and that `!.env` in .rboxignore is the way to override it.
REALITY: Since .env is ALSO a hardcoded builtin ignore pattern, it's plausible (untested here) that a bare `!.env` override wouldn't be enough on its own if builtin rules take precedence in some way, or it may work fine -- the screen doesn't clarify the two-layer (builtin + gitignore) precedence at all, so the override instruction's completeness is unverifiable from the screen alone.

## [5 P2×S1]
SCREEN: ? Press Enter to sign up in your browser (advanced: enter an account bootstrap secret) [input is masked]
EXPECTED: A single, unambiguous instruction for how to proceed as a new-account first-time user.
REALITY: The line conflates two very different actions (press Enter for browser signup vs. type a masked secret) in one prompt, and introduces the undefined term 'account bootstrap secret' with no explanation of what it is or when it would be used, forcing a literal reader to pause and guess before committing to the default action.

## [6 P2×S3]
SCREEN: this machine shows a confirmation code you approve elsewhere — different from a pairing token: it authorizes but does not carry encryption
EXPECTED: A one-line caption that unambiguously states the consequence of picking this option, on first read.
REALITY: 'it authorizes but does not carry encryption' required two re-reads to parse — is it saying no encryption key material transfers via this method (so a follow-up step is needed elsewhere), or something about transport security? Only became clear by cross-referencing the sibling option's caption ('carries your encryption key'). A cautious reader has to build an inference chain across two menu items 

## [6 P2×S3]
SCREEN: ^[  (literal escape character printed to screen after pressing Escape while 'Waiting for approval (expires in 600s)...')
EXPECTED: Escape should either do nothing silently, or show a hint like 'press Ctrl-C to cancel', consistent with the interactive-prompt convention used one screen earlier.
REALITY: The waiting state isn't reading structured key input at all (it's a bare poll loop), so Escape leaks through as a literal raw escape sequence on screen. This looks like an error or stray keystroke artifact to a cautious reader, with zero on-screen affordance for how to actually cancel at this point.

## [10 P3×S3]
SCREEN: ? Open the approval page?
❯ Open in browser
  Copy URL to clipboard
  I'll approve it another way
EXPECTED: Selecting 'I'll approve it another way' would either print the full URL for manual use, or explicitly restate the `rbox device approve <code>` fallback command so I know exactly what to do next.
REALITY: Choosing it just checks the item and silently returns to the same 'Waiting for approval (expires in 600s)...' screen with no new guidance. The only usable next step (the `rbox device approve CODE` command) was already printed two lines above the menu and is not repeated or highlighted after this choice — a user who scrolled past it or is on a small terminal could miss it entirely.

## [11 P3×S4]
SCREEN: ✗ rbox: Workspace limit reached — plan allows 1. Upgrade with `rbox subscribe solo` for unlimited workspaces.
EXPECTED: N/A — this surfaced only because I (the agent) tried to work around the tilde bug via direct CLI by creating a second workspace; a real user following only the TUI would not hit this exact message in 
REALITY: Included for completeness: the workspace limit is enforced and the message is clear about the remedy, so this one is not itself a UX problem.

## [12 P3×S7]
SCREEN: Signed in and enrolled (acct_32e7820cb86eb92f) — skipping account setup.
EXPECTED: Given the persona's memory of 'there was a pairing thing' and CLAUDE.md/STATUS.md context that identity banners were recently reworked (v1.6.2, design 117) to show email + sign-in method instead of ra
REALITY: Both the `rbox setup` welcome banner and `rbox status`'s account line show only the opaque id `acct_32e7820cb86eb92f`, with no email or sign-in method. This looks like the design-117 identity-banner treatment did not reach the setup wizard's greeting or `rbox status`'s account summary line.

## [13 P4×S1]
SCREEN: ? Press Enter to sign up in your browser (advanced: enter an account bootstrap secret) [input is masked]
EXPECTED: Since the primary action is just 'press Enter,' I'd expect the input field not to be masked, or an explanation of why a plain keypress prompt has password-style masking.
REALITY: The prompt shows '[input is masked]' with no explanation — confusing for a user who has no bootstrap secret and is just trying to press Enter. It reads like a password prompt for an action that isn't one.

## [16 P5×S1]
SCREEN: ✔ Open the approval page? I'll approve it another way
EXPECTED: Choosing the deliberately non-browser option would either exit back to the shell with clear next-step instructions, or show a distinct confirmation of what to do now.
REALITY: The screen just re-collapses to the same static "Waiting for approval (expires in 600s)..." block that was already showing, with no new guidance beyond what had already been printed above (the relative URL and the `rbox device approve <code>` command). It reads as if nothing happened.

## [17 P5×S2]
SCREEN: C-c on the account-method sub-step ('Press Enter to sign up in your browser...')
EXPECTED: Ctrl-C during a wizard step cancels/backs out the current step or exits with a clean cancellation message, leaving the terminal usable.
REALITY: The entire process/tmux pane died instantly with no visible cancellation message captured; `tui.ts stop` afterward reported the session was already stopped. Had to fully restart `rbox setup` from step 1.

## [18 P5×S5]
SCREEN: (after C-c on the "Workspace id to sync" prompt)
EXPECTED: Ctrl-C cancels the current step/prompt and returns to a shell or a previous menu.
REALITY: Ctrl-C tore down the entire tmux pane/process ("tmux capture-pane failed") rather than returning control gracefully — only option was to fully re-run `rbox setup` from scratch.

## [19 P5×S8]
SCREEN: keys C-c on the masked bootstrap-secret prompt -> tmux capture-pane failed (exit 1); child output suppressed
EXPECTED: Ctrl-C mid-wizard (a very common fumble - hitting the wrong menu item, then bailing) should cleanly cancel back to a shell prompt, ideally with a 'cancelled' message, so the user knows the wizard was 
REALITY: Ctrl-C also killed the pane/session with no visible confirmation text, indistinguishable on-screen from the token-crash above. Both a legitimate abort (Ctrl-C) and an actual crash (bad token) look identical to the user: the terminal just goes dead. Lower severity than the token crash since Ctrl-C IS supposed to terminate the process, but the total silence (no 'setup cancelled' line) means a user c

## [20 P5×S8b]
SCREEN: To authorize this device, visit:

    /cli-login?code=TNZW-5X5N
EXPECTED: A "visit" instruction should be a complete, clickable/typeable absolute URL.
REALITY: The line rendered as a bare path with no scheme or host, which is unusable if a user actually tries to visit it. This is very likely a harness artifact — WALKTHROUGH.md states RBOX_APP is deliberately blanked in this environment to prevent redirecting into the production dashboard — so it is flagged for verification against a real (non-harness) run rather than asserted as a live bug.


# COPY ISSUES

## [1 P1×S1] Two affordances (bare Enter vs. typed secret) merged into one masked-input prompt; masking also hides whether anything is being typed/echoed at all.
SCREEN: ? Press Enter to sign up in your browser (advanced: enter an account bootstrap secret) [input is masked]
SUGGEST: Press Enter to sign up in your browser. (Have a bootstrap secret? Type it now — input hidden.)

## [2 P1×S2] Instructs the user to relaunch a command they are already running, immediately above the exact menu being described — redundant and momentarily confusing about whether the wizard chained correctly.
SCREEN: Run `rbox setup` and choose "Sync an existing workspace" to get your existing folder syncing here.
SUGGEST: Continue below and choose "Sync an existing workspace" to get your existing folder syncing here.

## [2 P1×S2] No help text, example, or lookup hint, breaking the pattern set by every other prompt in the same wizard (the pairing-token step had a full explanatory line).
SCREEN: ? Workspace id to sync
SUGGEST: ? Workspace id to sync  (find it with `rbox list` on your other machine)

## [3 P1×S5] 'gitignored untracked files' is slightly redundant/technical phrasing (gitignored files are untracked by definition unless force-added) that a fast skimmer has to parse an extra beat to trust. It does
SCREEN: Skip gitignored untracked files (recommended)
SUGGEST: Skip files your .gitignore excludes, like .env and node_modules/ (recommended)

## [4 P1×S7] A returning power user re-running `--list` to sanity-check a pattern they just added has to scroll past the entire built-in default list every time. respectGitignore state is helpfully printed first, 
SCREEN: rbox ignore --list output: ~50 lines of `[builtin] ...` patterns printed before the two `[.gitignore ...]` lines and the one `[.rboxignore] *.log` lin
SUGGEST: Print a short "your rules" section first (respectGitignore state + .rboxignore entries), then the full builtin/gitignore dump below it, or add a `--mine`/`--custom` flag to skip builtins.

## [4 P1×S7] Once respectGitignore is on, .gitignore lines get an explicit ACTIVE qualifier but .rboxignore lines never get any state qualifier at all (they're always active, but that's left implicit) — a skimmer 
SCREEN: [.gitignore ACTIVE] node_modules/  vs  [.rboxignore] *.log
SUGGEST: [.rboxignore · always active] *.log

## [5 P2×S1] Missing scheme and host makes the single most load-bearing instruction on the screen unfollowable as literally written.
SCREEN: To authorize this device, visit:

    /cli-login?code=93AU-LD5Z
SUGGEST: To authorize this device, visit:

    https://app.rbox.to/cli-login?code=93AU-LD5Z

## [5 P2×S1] Selecting this menu item produces no visible change or new instructions, so it reads as broken or as having done nothing.
SCREEN: I'll approve it another way
SUGGEST: I'll approve it another way

(then, on selection, print something like:) You can also approve from any device by opening the URL above, or by running `rbox device approve 93AU-LD5Z` from another machi

## [5 P2×S1] Introduces an undefined technical term inline in the primary prompt with no explanation, creating hesitation for a literal reader before they even take the default path.
SCREEN: (advanced: enter an account bootstrap secret)
SUGGEST: Press Enter to sign up in your browser. (Have an invite/bootstrap code instead? Paste it here.)

## [6 P2×S3] Missing scheme and host makes this unusable as a literal instruction ('visit:'), and also means it can't be reliably copy-pasted by a user reading over someone's shoulder or relaying it verbally/via c
SCREEN: /cli-login?code=XXXX-XXXX
SUGGEST: https://app.rbox.to/cli-login?code=XXXX-XXXX (or whatever the real production host is) printed in full

## [6 P2×S3] Ambiguous shorthand for a security-relevant distinction; a first-time user deciding between three auth methods deserves a self-contained sentence, not one that requires comparing captions across menu 
SCREEN: it authorizes but does not carry encryption
SUGGEST: e.g. "you approve this device from a browser elsewhere; unlike pairing, this device won't receive your encryption key over this channel"

## [7 P2×S4] This line is the only signal a user gets that the workspace they just linked has no content yet, and it reads as routine sync telemetry rather than a warning. There's no distinction between 'this work
SCREEN: synced: 0 pulled, 0 conflict(s) → sequence 0
SUGGEST: "0 files pulled — nothing to sync yet from other devices" (neutral) would at least prompt a cautious reader to check machine a, versus the current phrasing which reads as confirmation everything is fi

## [7 P2×S4] This next-step instruction was accurate and directly followable — worth calling out as a design-134 next-step chain that DOES work end-to-end for a cautious reader (see delights). No issue here, noted
SCREEN: device authorized + encryption enrolled: dev_12b4777d9687b9a479741384e8ad1b23
Run `rbox setup` and choose "Sync an existing workspace" to get your exi
SUGGEST: 

## [8 P2×S6] The URL to visit is printed as a bare relative path with no scheme or host (e.g. missing `https://app.rbox.to`). A cautious reader who takes the screen literally cannot type this into a browser as-is;
SCREEN: To authorize this device, visit:

    /cli-login?code=[REDACTED]
SUGGEST: To authorize this device, visit:

    https://app.rbox.to/cli-login?code=XXXX-XXXX

## [8 P2×S6] For a user recovering account access with a seed phrase, none of these three labels say what to do, and two of the three ('Sign in via browser' / 'Approve a code') are functionally identical, which re
SCREEN: ❯ Paste a pairing token
  Sign in via browser
  Approve a code
SUGGEST: Add a fourth option, e.g. '❯ Recover with my 24-word phrase', or clarify in the sub-heading which of the three existing options a lost/new device without pairing access should choose.

## [9 P3×S2] Phrased as an imperative to re-run a command ('Run `rbox setup`') when the user is already mid-wizard and the very next line is that exact choice. Reads like guidance for a different session/later tim
SCREEN: Run `rbox setup` and choose "Sync an existing workspace" to get your existing folder syncing here.
SUGGEST: Pick "Sync an existing workspace" below to get your existing folder syncing here.

## [10 P3×S3] Relative path with no domain — not a usable URL for a human to copy into a browser on another device.
SCREEN: To authorize this device, visit:

    /cli-login?code=KE5B-VTPM
SUGGEST: To authorize this device, visit:

    https://app.rbox.to/cli-login?code=KE5B-VTPM

## [10 P3×S3] 'I'll approve it another way' is a fine label but gives no feedback when chosen — it should re-surface the fallback command so the terminal-only path stays visible at the exact moment the user commits
SCREEN: ? Open the approval page?
❯ Open in browser
  Copy URL to clipboard
  I'll approve it another way
SUGGEST: After selecting it: 'OK — run `rbox device approve KE5B-VTPM` on an already-signed-in machine, or visit the URL above from any browser. Still waiting for approval (expires in 600s)...'

## [11 P3×S4] No indication that a leading ~ will not be expanded to the home directory, and no post-entry confirmation of the resolved absolute path before committing. Since the default shown IS an absolute path, 
SCREEN: ? Which directory should rbox sync? (/tmp/rbox-ux/flow11/a)
SUGGEST: Either silently expand a leading ~/ to the home directory before use (the actual fix), or if that's intentionally unsupported, echo back the resolved absolute path for confirmation: "Which directory s

## [11 P3×S4] A 0-file first push after pointing at a directory the user believes has content should be flagged, not presented as a clean success.
SCREEN: ✓ already in sync — nothing to upload (sequence 0)
rbox push files=0 blobs=0 ct=0B wire=0B changed=0B
SUGGEST: "0 files found in this directory - is it the right one? (nothing will sync until it has content)" when the scanned file count is 0 on a brand-new workspace's first push.

## [12 P3×S7] Inconsistent tagging scheme across the three rule sources (builtin / .gitignore / .rboxignore) makes 'active' ambiguous for the two sources that never carry a tag.
SCREEN: [.gitignore ACTIVE] ... vs [.rboxignore] *.bak (no tag)
SUGGEST: Tag every rule with an explicit state, e.g. '[builtin, always active]', '[.gitignore, active]' / '[.gitignore, not applied — respectGitignore off]', '[.rboxignore, always active]' -- so the reader nev

## [12 P3×S7] This long-form tag (seen only when respectGitignore is off) is clear and well-written on its own, but it never appears next to its shorter ON-state counterpart 'ACTIVE', so a user only ever sees one h
SCREEN: [.gitignore present but NOT applied (respectGitignore off)] node_modules/
SUGGEST: Use a symmetric short/long pair, e.g. '[.gitignore ACTIVE — respectGitignore on]' vs '[.gitignore NOT APPLIED — respectGitignore off]', so both states are self-explanatory without needing to see the o

## [13 P4×S1] URL is missing scheme and host; a security-conscious user cannot verify or manually relay the destination.
SCREEN: To authorize this device, visit:

    /[path]?code=[REDACTED]
SUGGEST: To authorize this device, visit:

    https://app.rbox.to/[path]?code=[REDACTED]

## [13 P4×S1] This menu item implies an alternative flow exists but resolves to nothing new — it silently returns to the same waiting screen with no new information, which reads as broken rather than as an intentio
SCREEN:   I'll approve it another way
SUGGEST: If it must remain a dead end for browser-less devices, say so explicitly, e.g.: 'No browser here? Ask someone with an already-signed-in rbox machine to run `rbox device approve [REDACTED]`, or come ba

## [13 P4×S1] The encryption claim is a bare tagline with zero backing detail anywhere in the flow reached, which reads as marketing rather than a security posture a secops reviewer can evaluate.
SCREEN: ◆  Welcome to rbox — end-to-end encrypted sync for your dev workspaces.
SUGGEST: Welcome to rbox — end-to-end encrypted sync for your dev workspaces. Keys are generated on this device and never leave it unencrypted; see https://rbox.to/security for details.

## [14 P4×S2] Tells the user to run a command they are already running, immediately before the wizard asks the very question this line describes. Self-contradictory in the interactive path.
SCREEN: Run `rbox setup` and choose "Sync an existing workspace" to get your existing folder syncing here.
SUGGEST: Drop this line when the wizard is about to continue into Step 2 in the same session; reserve it only for paths that actually exit (e.g. `rbox pair`/`rbox connect` invoked outside the setup wizard).

## [15 P4×S6] This hint (and the parallel one on 'Approve a code': 'it authorizes but does not carry encryption') is good, trust-earning copy for this persona, but both assume you HAVE another already-set-up machin
SCREEN: run `rbox pair` in a terminal on an already-set-up machine — never shown in the dashboard because it carries your encryption key
SUGGEST: Add a line for the no-other-device case, e.g. under the auth-method menu: 'No other device? Recover with your 24-word phrase instead.' (as a 4th menu item or a footer hint).

## [15 P4×S6] 'account bootstrap secret' and '24-word recovery phrase' may or may not be the same underlying mechanism from the user's perspective, but the copy never says so, and the persona brief explicitly expec
SCREEN: Press Enter to sign up in your browser (advanced: enter an account bootstrap secret) [input is masked]
SUGGEST: If the bootstrap secret IS effectively the recovery mechanism, rename it in-UI to something a secops reader would recognize, e.g. '(recovering an existing account? enter your recovery phrase)', so the

## [16 P5×S1] Missing scheme+host turns an otherwise-fine device-code flow into a dead end for anyone reading the terminal literally.
SCREEN: To authorize this device, visit:

    /cli-login?code=X9ZY-ZTJQ
SUGGEST: To authorize this device, visit:

    https://app.rbox.to/cli-login?code=X9ZY-ZTJQ

## [16 P5×S1] A single prompt overloads two very different actions (press Enter for the common browser path vs. type a masked secret for the advanced path) with no visible distinction once you start typing, and no 
SCREEN: ? Press Enter to sign up in your browser (advanced: enter an account bootstrap secret) [input is masked]
SUGGEST: Press Enter to sign up in your browser, or paste an account bootstrap secret (advanced, input hidden): 

## [16 P5×S1] No visible "go back" affordance is mentioned anywhere in the footer hints (only "↑↓ navigate • ⏎ select"), so a user has no way to know Escape won't work before trying it.
SCREEN: ❯ Paste a pairing token
  Sign in via browser
  Approve a code
SUGGEST: ↑↓ navigate • ⏎ select • Esc back

## [17 P5×S2] Appears mid-wizard, right before the very same choice is offered on-screen one line later — contradicts the user's actual context (they're already in `rbox setup`, not needing to re-invoke it).
SCREEN: Run `rbox setup` and choose "Sync an existing workspace" to get your existing folder syncing here.
SUGGEST: Drop this line inside the wizard entirely (the Step 2 prompt below already offers the choice), or if it's meant for a machine that exits after `rbox pair`-only flows, gate it so it only shows when the

## [17 P5×S2] Clear and actionable, but this next-step instruction lives in `rbox status` output, not in the setup wizard itself, so a user who doesn't know to run `rbox status` after setup exits may never see it.
SCREEN: ↑ 3 local changes to sync (3 new) — background sync stopped; run `rbox start`
SUGGEST: Have the wizard itself print a brief final banner before exiting, e.g. "Workspace ~ created — background sync is stopped. Run `rbox start` to begin syncing."

## [18 P5×S5] This is actually the strongest screen in the flow — flagging as a positive, not a defect. The hint line names .env as the concrete worked example, which directly answers "what happens to my secrets fi
SCREEN: ? How should rbox handle gitignored files?
❯ Skip gitignored untracked files (recommended)
  Sync gitignored files too (end-to-end encrypted)

re-incl
SUGGEST: 

## [18 P5×S5] Clear about the fix (upgrade) but offers no way to free/delete an accidental/phantom workspace, and gives zero indication of which workspace is consuming the slot or how to find out. A fumbler who jus
SCREEN: ✗ rbox: Workspace limit reached — plan allows 1. Upgrade with `rbox subscribe solo` for unlimited workspaces.
SUGGEST: Workspace limit reached — plan allows 1 (used by "myproect", created just now). Delete it with `rbox workspace delete myproect`, or upgrade with `rbox subscribe solo` for unlimited workspaces.

## [18 P5×S5] Shows a raw account id (acct_db55ea25d37c5c9f) rather than the email/sign-in-method identity banner that shipped in the recently-released v1.6.2 (per project STATUS notes: "identity banners show email
SCREEN: Signed in and enrolled (acct_db55ea25d37c5c9f) — skipping account setup.
SUGGEST: 

## [19 P5×S8] None - flagging this as a positive contrast, not an issue. This is the non-interactive `echo garbage-token | rbox connect` error, and it is excellent: precise, names the exact expected shape, clean ex
SCREEN: ✗ rbox: malformed pairing token (expected `rbox-pair_<id>.<secret>`)
SUGGEST: N/A - keep as-is; propagate this exact validation/error path into the `rbox setup` -> 'Paste a pairing token' prompt so the interactive flow gets the same message instead of crashing.

## [20 P5×S8b] Bare relative path shown as the thing to "visit", missing scheme + host. Even caveated as a harness artifact (blanked RBOX_APP), this is worth a defensive check that the CLI always has a resolved app 
SCREEN: /cli-login?code=TNZW-5X5N
SUGGEST: https://app.rbox.to/cli-login?code=TNZW-5X5N (or whatever the resolved RBOX_APP host is)


# DELIGHTS
- [1 P1×S1] Bare `rbox` with no args prints a full, dense, unix-style command reference (GETTING STARTED / SYNCING / DEVICES & ACCOUNT / BILLING & MAINTENANCE sections, aligned columns, --help and exit-code point
- [1 P1×S1] The setup wizard shows an explicit 'Step 1 of 3 · Account' progress header and keeps prior answers visible with checkmarks (e.g. '✔ Are you new here... Create a new account'), so a skimmer can see wiz
- [1 P1×S1] The browser-handoff screen states the code's 600s expiry up front and offers a real non-browser escape hatch inline ('or run `rbox device approve <code>` on an already-signed-in machine') plus an expl
- [2 P1×S2] The 'How do you want to authorize this machine?' menu shows the terse hint 'run `rbox pair` in a terminal on an already-set-up machine — never shown in the dashboard because it carries your encryption
- [2 P1×S2] The pairing token input is masked on screen the entire time it's typed, so no accidental token leakage even mid-entry.
- [2 P1×S2] Re-running `rbox setup` after the crash correctly detected prior enrollment and skipped straight past account setup: 'Signed in and enrolled (acct_3428dbd61625f33b) — skipping account setup.' and adju
- [3 P1×S5] The gitignore step correctly defaults to the safe choice ('Skip ... recommended') pre-highlighted, so a fast typist who just mashes Enter through the whole wizard ends up safe by default.
- [3 P1×S5] The example in the hint line uses `!.env` specifically rather than a generic placeholder -- that's a smart, concrete choice that reinforces 'yes, .env is the kind of thing this protects' even on a ski
- [3 P1×S5] The second option proactively states '(end-to-end encrypted)' right on the menu line, addressing the 'does this leave my machine unprotected' worry before a security-minded user even has to ask.
- [3 P1×S5] `rbox ignore --list` after the fact is genuinely reassuring: it shows .env is protected by ~15 built-in secret patterns (*.pem, *.key, id_rsa, *.sqlite, etc.) independent of whatever gitignore choice 
- [3 P1×S5] Re-running `rbox setup` against an already-tracked directory correctly detected the collision with clear, calm copy: 'This directory already syncs to workspace proj (...). Create a brand-new workspace
- [4 P1×S7] Gitignore-handling step in setup: "re-include specific files with ! lines in .rboxignore (e.g. !.env), or switch later with `rbox ignore --respect-gitignore off`" — tells you the exact follow-up comma
- [4 P1×S7] Workspace-name prompt: "a workspace name is OPTIONAL and shown in the web dashboard (visible to rbox, server-side — NOT end-to-end encrypted)." — bolded OPTIONAL plus a precise, unhedged privacy cavea
- [4 P1×S7] `rbox ignore --list` active-vs-not-applied wording is exactly the kind of thing a skimmer needs: `[.gitignore present but NOT applied (respectGitignore off)]` flips to `[.gitignore ACTIVE]` the moment
- [4 P1×S7] `rbox ignore '*.log'` confirmation: "added to .rboxignore: *.log" followed immediately by "(forward-only: already-synced matches keep their last copy on other machines and stop syncing. to remove a fi
- [4 P1×S7] Toggling `--respect-gitignore on` prints "already-synced ignored files are carried forward. Run `rbox ignore --purge` to delete those stale copies explicitly." — again, exact next command supplied, no
- [5 P2×S1] The wizard clearly labels progress ('Step 1 of 3 · Account') and marks completed steps with a checkmark plus the choice made (e.g. '✔ Are you new here...? Create a new account'), which is easy for a c
- [5 P2×S1] The pairing/device code and its expiry are stated plainly ('93AU-LD5Z', 'expires in 600s'), giving a literal reader a concrete, unambiguous artifact even though the surrounding URL was broken.
- [5 P2×S1] Running bare `rbox` on a virgin machine correctly routes straight into the setup wizard rather than dumping a generic help screen, matching the documented 'front door' behavior.
- [6 P2×S3] The 'Approve a code' screen prints a working terminal-only fallback directly inline: '(or run `rbox device approve <CODE>` on an already-signed-in machine)' -- exactly what a headless/SSH-only user ne
- [6 P2×S3] The third submenu option 'I'll approve it another way' has a caption that correctly sets expectations ('keep waiting — approve from any browser or another terminal') -- it doesn't cancel setup, it jus
- [6 P2×S3] Backing out via Ctrl-C during the wait does NOT wedge setup: re-running `rbox setup` against the same HOME afterward restarts cleanly at 'Step 1 of 3 · Account' with no orphaned device-code state or c
- [7 P2×S4] The pairing flow itself is genuinely well-designed for a cautious reader: machine a's `rbox pair` output ('On the new machine, run `rbox setup`, choose "Log into an existing account", then "Paste a pa
- [7 P2×S4] After pairing, b's setup wizard proactively printed 'Run `rbox setup` and choose "Sync an existing workspace" to get your existing folder syncing here' — this is the design-134 next-step chain working
- [7 P2×S4] The workspace-name prompt's phrasing ('a workspace name is OPTIONAL and shown in the web dashboard (visible to rbox, server-side — NOT end-to-end encrypted)') is exactly the kind of precise, literal c
- [7 P2×S4] The gitignore-handling prompt was similarly well-scoped: default clearly marked '(recommended)', with a concrete escape hatch spelled out ('re-include specific files with ! lines in .rboxignore ... or
- [8 P2×S6] Step numbering ('Step 1 of 3 · Account') gives a clear sense of progress and scope up front.
- [8 P2×S6] The pairing-token screen includes a genuinely reassuring security note: 'never shown in the dashboard because it carries your encryption key' -- concrete and specific, not generic security theater.
- [8 P2×S6] Completed choices are echoed back with a checkmark and the selected value (e.g. '✔ Are you new here...? Log into an existing account'), which is good for a cautious reader retracing their steps.
- [8 P2×S6] The wizard is forgiving of Ctrl-C and restart -- resetting from a virgin machine cleanly returned to the Step 1 menu every time, with no corrupted state.
- [9 P3×S2] The 'How do you want to authorize this machine?' menu directly answers the exact question this persona needed answered without any prior doc-reading: 'run `rbox pair` in a terminal on an already-set-u
- [9 P3×S2] Pairing-token input is masked ('[input is masked]') while typing/pasting -- reassuring given the token 'carries your encryption key' warning just shown.
- [9 P3×S2] Enrollment succeeded on the first paste with a clear, unambiguous confirmation line: 'device authorized + encryption enrolled: dev_79a17b13bac7d3b87d91a6615599847b'.
- [9 P3×S2] The 'Step N of 3 · <Section>' progress header gives a clear, low-anxiety sense of place throughout the wizard.
- [10 P3×S3] The device-code wait step polls and auto-advances the moment the code is approved elsewhere (tested by running the printed `rbox device approve <code>` fallback command on an enrolled machine A) — no 
- [10 P3×S3] After device authorization, the wizard correctly detects the machine is authorized-but-not-encryption-enrolled and pivots straight to a clear, numbered next-step message instead of just declaring succ
- [10 P3×S3] 'I'll do this later' at the enrollment step ends setup cleanly (not a hang), and re-running `rbox setup` afterward resumes exactly at the missing step (skips the already-completed account/device auth)
- [10 P3×S3] Ctrl-C at the browser-handoff 'Open the approval page?' prompt aborts immediately and leaves the machine in a state where `rbox setup` restarts cleanly from Step 1 — no wedge, no stale device-code ref
- [11 P3×S4] The post-pairing message on machine b is exactly right: "device authorized + encryption enrolled: ... Run `rbox setup` and choose 'Sync an existing workspace' to get your existing folder syncing here.
- [11 P3×S4] The 'Sync an existing workspace' picker listed the workspace by its human-readable name and age: "~/proj - created 4m ago - never synced - ws_d4e7f240" - trivially easy to recognize as the right one v
- [11 P3×S4] Encryption messaging is consistent and reassuring throughout: "this workspace is end-to-end encrypted - the server never sees your file names or contents" appears at the same point in both the create 
- [11 P3×S4] The `rbox pair` output on machine a is a single clean copy-pasteable command with a clear expiry and reuse warning ("valid ~10 min, single use - carries your encryption key") plus the exact next comma
- [12 P3×S7] `rbox ignore '*.bak'` gives an immediate, specific consequence warning: "added to .rboxignore: *.bak / (forward-only: already-synced matches keep their last copy on other machines and stop syncing. to
- [12 P3×S7] Re-enabling respect-gitignore prints a matching proactive warning: "already-synced ignored files are carried forward. Run `rbox ignore --purge` to delete those stale copies explicitly." -- the same 't
- [12 P3×S7] The workspace-name prompt during setup volunteers a genuinely useful security disclosure unprompted: "a workspace name is OPTIONAL and shown in the web dashboard (visible to rbox, server-side — NOT en
- [12 P3×S7] The OFF-state tag '[.gitignore present but NOT applied (respectGitignore off)]' is, read on its own, excellent: unambiguous about both the state and the reason for it.
- [13 P4×S1] The account-choice framing ('Are you new here, or do you already have an rbox account?') is plain, jargon-free, and immediately actionable — no docs needed to understand it.
- [13 P4×S1] The device-code screen does show a clear expiry ('expires in 600s') and a fallback command syntax (`rbox device approve <code>`), which is the right idea even though the fallback doesn't apply to this
- [13 P4×S1] Step counter ('Step 1 of 3 · Account') sets expectations about flow length up front, which is reassuring before committing to an account-creation decision.
- [14 P4×S2] The very first line of `rbox setup`, before any commitment, states 'end-to-end encrypted sync for your dev workspaces' — a security-relevant claim is front-loaded, not buried.
- [14 P4×S2] The auth-method menu proactively answers the exact questions a secops reader would have about a pairing token without any outside knowledge: 'run `rbox pair` in a terminal on an already-set-up machine
- [14 P4×S2] The `rbox pair` output is precise and non-hand-wavy: 'Pairing token (valid ~10 min, single use — carries your encryption key)' states expiry, single-use, and exactly what the token contains — not mark
- [14 P4×S2] The token-entry prompt explicitly states '[input is masked]' before typing begins, confirming no plaintext echo of key material to the terminal.
- [14 P4×S2] The enrollment success line is specific and falsifiable — 'device authorized + encryption enrolled: dev_...' — naming device authentication and encryption enrollment as two distinct completed steps ra
- [15 P4×S6] The welcome banner leads with a concrete security claim ('end-to-end encrypted sync for your dev workspaces') rather than vague marketing language — sets the right tone for a security-conscious reader
- [15 P4×S6] The pairing-token menu proactively explains key custody before you commit: 'never shown in the dashboard because it carries your encryption key' — this is exactly the kind of unprompted detail that ea
- [16 P5×S1] Running bare `rbox` on a totally virgin machine goes straight into the setup wizard (Step 1 of 3 · Account) instead of printing generic --help text or erroring — there is no dead front door.
- [16 P5×S1] After the Ctrl-C kill and the garbage-secret crash, re-running `rbox setup` both times restarted cleanly at Step 1 with no corrupted state, no stale lockfile complaints, no half-finished account artif
- [16 P5×S1] The wizard's step counter ("Step 1 of 3 · Account") and the running list of confirmed answers (✔ Are you new here...? Create a new account / ✔ Press Enter to sign up...) give good orientation of progr
- [16 P5×S1] The non-browser escape hatch is stated proactively and specifically: `rbox device approve <code>` is printed right alongside the visit URL, which is the right instinct even though the URL itself is br
- [17 P5×S2] The 'How do you want to authorize this machine?' screen self-documents the pairing token's origin unprompted: "run `rbox pair` in a terminal on an already-set-up machine — never shown in the dashboard
- [17 P5×S2] The pairing token was pasted with two trailing spaces (fumbler-style sloppy paste) and enrollment still succeeded silently — the CLI evidently trims/tolerates trailing whitespace rather than rejecting
- [17 P5×S2] `rbox setup`, when re-run on an already-enrolled machine, correctly detects and skips the account step ("Signed in and enrolled (acct_...) — skipping account setup"), reducing step count from 3 to 2 —
- [18 P5×S5] The gitignore-choice screen's hint text uses .env as a concrete, literal example of both what gets skipped and how to re-include it (`!.env` in `.rboxignore`) — exactly the kind of specific, non-abstr
- [18 P5×S5] The second gitignore option ("Sync gitignored files too (end-to-end encrypted)") proactively reassures a security-conscious reader that opting in is still encrypted, building trust into the riskier ch
- [18 P5×S5] Re-running `rbox setup` fresh after a Ctrl-C worked cleanly — no corrupted state, no leftover wizard progress, straight back to the Step 1 menu.
- [19 P5×S8] The non-interactive path's error copy is genuinely good UX: ✗ rbox: malformed pairing token (expected `rbox-pair_<id>.<secret>`) tells you exactly what shape is expected, no jargon, no stack trace.
- [19 P5×S8] The wizard's step framing ('Step 1 of 3 · Account') and the inline hint under 'How do you want to authorize this machine?' ('run `rbox pair` in a terminal on an already-set-up machine - never shown in
- [20 P5×S8b] Crash-safety at the state layer is genuinely solid: across 3 independent Ctrl-C kills and 2 hostile-input kills (5 total process deaths), every single re-run of `rbox setup` came back to an identical,
- [20 P5×S8b] The "Approve a code" screen has thoughtful, trust-building copy: it explains why the pairing-token option is "never shown in the dashboard because it carries your encryption key", and offers three dis
- [20 P5×S8b] The persistent "Step 1 of 3 · Account" step header gives good orientation throughout — a fumbler always knows roughly how far into the wizard they are, even after several restarts.


# OUTCOMES
- 1 P1×S1: blocked-by-harness(reached the required browser handoff for account sign-up on a virgin machine; harness forbids clicking through, so the flow stops t
- 2 P1×S2: completed
- 3 P1×S5: completed
- 4 P1×S7: completed(via direct `rbox ignore` commands through the exec prefix, after abandoning the interactive `rbox setup` wizard — reproducible crash on both
- 5 P2×S1: abandoned(browser handoff — 'To authorize this device, visit: /cli-login?code=93AU-LD5Z' is a bare host-less path, and the explicit no-browser menu op
- 6 P2×S3: completed
- 7 P2×S4: abandoned(machine a: `rbox setup` reproducibly crashes/kills the whole TUI session while creating a workspace from a directory that has real file cont
- 8 P2×S6: abandoned(setup step 1 of 3 -- no 24-word recovery-phrase path could be found anywhere in `rbox setup`, after exhaustively checking all reachable menu
- 9 P3×S2: completed
- 10 P3×S3: completed
- 11 P3×S4: abandoned(the second-device sync-existing-folder goal was never reached: after following every on-screen instruction exactly through pairing + "Sync a
- 12 P3×S7: completed
- 13 P4×S1: abandoned(browser handoff reached; "I'll approve it another way" led nowhere for a first-machine/browser-less user, so the flow was stopped there per 
- 14 P4×S2: completed
- 15 P4×S6: abandoned(scenario S6 has no reachable entry point: `rbox setup` on a virgin/solo machine never presents a "recover with my 24-word phrase" option und
- 16 P5×S1: blocked-by-harness(reached the intended browser handoff cleanly and stopped per protocol, but two of the fumbler's realistic mistakes — Ctrl-C mid-wiz
- 17 P5×S2: completed
- 18 P5×S5: abandoned(unable to actually complete the correct workspace creation for the seeded git repo — the first fumbler typo silently created a phantom works
- 19 P5×S8: completed
- 20 P5×S8b: blocked-by-harness(the mechanical scenario completed — 3 Ctrl-Cs at 3 distinct screens plus empty/nonsense input at 2 masked prompts, each followed by
