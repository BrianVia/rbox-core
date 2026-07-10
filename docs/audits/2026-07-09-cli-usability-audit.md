rbox CLI usability audit
34 top-level commands, each independently reviewed against 5 criteria (easy to understand · simple language & verbs · clear configuration · documented · helpful errors & finish messages), plus a separate audit of whether every real capability is reachable through the CLI itself. Bar used throughout: a first-timer pastes a bare command from a friend's Slack message, with zero prior context — does it just work, and if not, does it tell them what to do?

Executive summary
The CLI's architecture is unusually disciplined for a hand-rolled dispatcher — one source-of-truth help registry, consistent --json conventions, generally excellent finish messages on the commands that were built carefully (untrack, trash, export, push/pull). But three systemic problems drag the average down, and one is a genuine data-loss bug:

rbox restore can silently destroy unpushed local edits. It overwrites the target file in place with no confirmation and no backup — the one command in the whole CLI that mutates local disk state without a safety net every sibling destructive command (untrack, ignore --purge, mass-delete guards) already has.
[path] means three different things depending on which command you're running — a directory locator (track, push, status, …), a --path flag instead (ignore, trash), or a file within the cwd's workspace with root silently pinned to cwd (versions, restore). This was confirmed by live reproduction, not just static reading — the exact same-looking rbox versions ws/file.txt and rbox status ws behave completely differently.
Jargon and raw internals leak into user-facing text constantly: "genesis", "materialize", "MK", "pidfile", "SIGTERM", "epoch", raw HTTP status+body dumps on generic failures. Individually minor; cumulatively they're why so many commands score 2-3 instead of 4-5.
There are also two broken/garbled strings that should just be fixed outright: pair's success message points users at a "Connect this machine" menu option that doesn't exist anywhere in the code, and one of its error messages contains a literal corrupted fragment (`rbox pair`-connect).

11 of 34 commands scored 2/5. None scored 1/5 (nothing is totally broken) and none scored 5/5 (nothing is held up as a model to copy elsewhere without caveats).

Score table (worst first)
Command	Score	Verdict
restore	2/5	Riskiest command in the CLI — unprompted, unrecoverable file overwrite, hiding behind a name that collides with the safer trash restore.
doctor	2/5	Best-designed health-check output in the CLI, but --report alone silently does nothing, and it refuses to run at all outside the exact tracked directory.
key	2/5	7 sub-verbs mixing regular-user and CI-only actions with no grouping; rbox key --help doesn't even show 2 of the 7 sub-verb docs.
pair	2/5	Finish message sends users to a UI option that doesn't exist; an error string is visibly garbled.
connect	2/5	Silently hangs with zero output if you don't pipe stdin exactly right — no TTY fallback prompt.
recover	2/5	Makes you type your 24-word recovery phrase before telling you it needed rbox login first.
versions	2/5	[path] silently means something different than every sibling command's [path].
ignore	2/5	Bare rbox ignore dumps 60+ lines of builtin patterns with no guidance; one warning is dense jargon.
stop	2/5	Every real message uses raw Unix jargon: "SIGTERM", "pidfile", "pid".
shell-init	2/5	Non-zsh users get a bare usage: rbox shell-init zsh — the fix is literally sitting in a code comment two lines away, never surfaced.
completions	2/5	Thinnest help entry in the registry (no examples), and its overlap with shell-init is never explained.
setup	3/5	Great guided wizard; 4 of 7 documented flags are silent no-ops outside keyed mode.
init	3/5	Well-tested, best error messages of the getting-started group; omitting both --new/--workspace silently creates a workspace, undocumented.
login	3/5	The zero-flag happy path is genuinely great; every other branch leaks jargon or raw server errors.
status	3/5	Clean happy-path output; its most likely first-run error routes beginners to the wrong command (track instead of setup).
start	3/5	Clear concept; success messages say "daemon"/"pid" with zero explanation.
autostart	3/5	Missing-subcommand error breaks the CLI's own styling convention (stdout + no fail()); dumps systemd jargon on every Linux status check.
logs	3/5	Excellent flag documentation; the actual log lines it prints ("ws error", "pump op quota") are written for the CLI's own authors.
sync	3/5	--allow-mass-delete quietly covers only the pull half; error message points at a different command than the one you ran.
track	3/5	Usage string says <path> is required; it's actually optional and silently defaults to cwd.
account	3/5	Well-built in isolation, but sits next to pair/connect in every listing with nothing distinguishing "link my web login" from "add a device."
uninstall	3/5	Good dry-run explanation, but --yes deletes the E2EE keystore with no recovery-phrase-backup warning.
logout	4/5	About as simple as a command can be; only miss is no warning before clearing your only device's credential.
push	4/5	One of the cleanest commands — flag semantics, error text, and success message all agree with what you typed.
pull	4/5	Same strength as push; conflict output could point at rbox versions for follow-up.
export	4/5	Best-documented command (real worked examples); overwrite/in-workspace refusals don't say what to do about it.
untrack	4/5	Best-explained command overall — proactively reassures "local files stay" before you even ask.
trash	4/5	Most polished of the sync-family commands; only wart is machine-generated --batch identifiers that are painful to retype.
device	4/5	Solid and consistent; missing-argument sub-verbs (approve/revoke) hit raw server 404s instead of a usage hint.
subscribe	4/5	Near-frictionless for the two real plans; generic failures leak raw server text.
billing	4/5	About as simple as a command can be; same raw-error-leak pattern on failure.
usage	4/5	Clean, no setup required; two account-state fields (grace, read-only) shown unexplained even when irrelevant.
upgrade	4/5	Strongest of the billing group — clear before/after confirmation on every path.
version	4/5	About as friendly as a single-purpose command gets; --help is silently ignored (prints the version instead).
Top fixes, ranked by impact
Add a confirmation + safety net to restore. src/engine/apply.ts:246-258 (restoreEntryToPath) overwrites the target file unconditionally via fs.rename. Before overwriting, either prompt ("this file has changes rbox hasn't synced yet — overwrite with version @N? [y/N]") or route the current on-disk copy through the existing trash tier first, the same way the pull-apply path already does (apply.ts:260-265). This is the one genuinely dangerous gap in the whole audit.
Warn before uninstall --yes deletes local key material. src/cli/uninstall-cmd.ts:79-101 recursively removes ~/.rbox, which holds the E2EE keystore and credentials, with zero warning and no recovery-phrase-backup nudge. Add a check + red warning pointing at rbox key backup when no kit has ever been written.
Fix pair's broken finish message. src/cli/auth-cmd.ts:362 tells users to choose "Connect this machine" from the rbox menu — that option doesn't exist (verified against front-door.ts and setup-cmd.ts's real menu options). This is the primary "add a second device" flow; fix it to reference the actual menu text or rbox connect.
Fix the garbled error string in the same file. src/cli/auth-cmd.ts:340 literally renders `rbox pair`-connect to the terminal — a leftover from a rename. One-line fix.
Unify what [path] means across the CLI, or at minimum stop versions/restore from silently deviating. main-dispatch.ts:363-368 and :370-380 resolve root from cwd only and reinterpret the positional as an in-workspace file, unlike every other command's directory-locator convention. Either make them consistent, or rename the argument/document the difference explicitly.
Make sync --allow-mass-delete cover both halves of the sync it names. src/cli/sync-cmd.ts:39 only sets the pull-side flag; push-side mass-deletes are still blocked with an error that tells the user to run rbox pull --allow-mass-delete even when they ran sync. Set both flags, or document the asymmetry in the flag's own description.
Decouple doctor --report preview from the --diagnostics upload gate, or fix the help text. refuseDisabledDiagnosticsUpload (main-dispatch.ts:296) blocks even local preview without --diagnostics, so rbox doctor --report — the single most natural thing to type from the --help text — currently does nothing. Also add a --path <dir> escape hatch to doctor (main-dispatch.ts:297) so it works as a troubleshooting tool even when the user isn't sure which directory they're in.
Give connect a TTY prompt fallback. src/cli/main-dispatch.ts:335-343 hangs silently with zero output if run without a pipe. recover already does this correctly (auth-cmd.ts:376-383) — mirror that pattern.
Fill in key's missing sub-verb help. key status and key backup have no COMMAND_HELP entries at all (2 of 7 sub-verbs), and rbox key --help never surfaces the 5 that do exist because helpFor short-circuits on the exact top-level match (help-registry.ts:490-495).
Replace raw HTTP status+body error dumps with friendly generic messages, system-wide. The pattern (`${cmd} failed: ${res.status} ${await res.text()}`) recurs in login, subscribe, billing, usage, and others — a single shared helper (friendlyHttpError(res, cmdName)) fixing all of them at once would be the highest-leverage single change in the codebase.
Coverage gaps — "should every option be usable via the CLI?"
Your instinct is correct — the coverage audit found this is already a real, systemic gap, not a hypothetical one:

--remote <url> is read by 5 commands but documented by none (login, upgrade, connect, track, init all read flags.remote; none list it in help-registry.ts). credentials.ts even tells users in a comment to use RBOX_API instead of the flag that already works.
rbox init is marked hidden: true even though it's the real headless/CI onboarding path and init-cmd.ts itself prints a recommended second-machine rbox init … command — a beginner scanning rbox help never learns it exists.
--git <true|false> opt-out works on track/init but isn't documented on either — and track-cmd.ts prints it back to the user at runtime ("git-sync: on (default; encrypted — --git false to opt out)") without it ever appearing in --help.
key materialize only accepts RBOX_KEY via env var, while setup (doing the identical unpack operation) accepts it three ways (--key -, --key-file, env var) — same operation, inconsistent CLI surface.
Config-file-only settings with no CLI surface at all: git.incremental (full-bundle-recapture escape hatch) and trash retention (trash.days, trash.maxBytes) both require hand-editing .rbox/workspace.json.
RBOX_PAIR_TOKEN, RBOX_DEBUG, and the dashboard URL override are env-var-only with no flag equivalent anywhere.
Minor: short-flag aliases (-f, -n, -y, -w, defined in flags.ts) work but appear in zero usage: strings.
Per-command detail (commands scoring ≤ 3/5)
restore — 2/5
High — no confirmation or backup before overwriting a file that may have unpushed local edits (apply.ts:246-258).
High — inherits versions' cwd-only root resolution bug.
Medium — a malformed <path>@<seq> (missing @seq) is masked by "not inside a workspace" instead of a usage hint, because validation order checks root before spec shape.
Medium — no flags/examples in its help entry at all; the only worked example lives in a runtime hint inside versions-cmd.ts.
Low — name collides with trash restore, no cross-reference in either help block.
doctor — 2/5
High — --report alone (no --diagnostics) produces nothing, not even a local preview, contradicting its own help text ("preview/upload").
High — hard-requires being inside the exact tracked directory; no --path <dir> escape hatch, unlike trash/ignore.
Medium — --diagnostics without --report is a silent no-op with no explanation.
Low — full raw diagnostics JSON (up to 512 KB) dumps to the terminal even with --yes; no summarized/verbose split.
key — 2/5
High — rbox key --help never shows the 5 sub-verb entries that exist, and key status/key backup have none at all.
Medium — "MK" shown raw in key status output, never expanded.
Medium — RBOX_KEY is not set gives no pointer to where one comes from.
Medium — "genesis"/"materialize" verb names teach nothing on their own; summaries help but errors reference the bare verb without them.
pair — 2/5
High — finish message references a nonexistent "Connect this machine" menu option.
High — error message contains a literal garbled fragment (`rbox pair`-connect).
Medium — no cross-reference distinguishing it from account link anywhere user-visible.
connect — 2/5
High — hangs silently with zero output if not piped correctly; no TTY prompt fallback (contrast recover, which does this right).
Medium — same account link confusability as pair.
recover — 2/5
High — prompts for the full 24-word recovery phrase before checking the rbox login-first prerequisite, wasting a first-timer's most sensitive input on a doomed attempt.
Medium — the login prerequisite is undocumented in --help.
versions — 2/5
High — [path] silently means "file within cwd's workspace" instead of "directory to locate the workspace from," breaking the convention every sibling command teaches. Confirmed via live reproduction.
Medium — the printed "restore with: …" hint hands the user to restore, which inherits the same bug.
ignore — 2/5
High — bare rbox ignore dumps 60+ lines of builtin patterns with zero framing or next-step hint.
Medium — no "add a pattern with…" footer, unlike trash list's equivalent.
Medium — one warning message is dense, unexplained jargon ("slashless negation", "gitignore directory pruning").
Low — uses --path <dir> instead of the positional convention every sync-family sibling uses.
stop — 2/5
High — success message is sent SIGTERM to rbox daemon (pid N) — raw signal/process jargon with no plain-language equivalent.
Medium — "pidfile" appears unexplained in two different messages.
Low — never confirms the process actually exited before reporting success.
shell-init — 2/5
High — non-zsh users get a bare usage: rbox shell-init zsh; the pointer to docs/shell-integration.md already exists in a code comment two lines above but isn't surfaced.
Medium — summary never explains in plain language what actually changes in the user's terminal.
completions — 2/5
Medium — no examples field at all, the thinnest help entry of the four maintenance commands; running it dumps ~60 lines of generated zsh with zero guidance on what to do with it.
Medium — same non-zsh dead end as shell-init, with no docs pointer even in a comment.
Low — overlap with shell-init (which already includes these completions) is never explained.
setup — 3/5
High — the "create a new account" prompt implies you need "another machine" if you don't have a bootstrap secret, when actually leaving it blank opens a normal browser sign-up.
High — 4 of 7 documented top-level flags (--dir, --daemon, --pull-only, --force) are silent no-ops unless combined with --workspace + a key; nothing warns you.
Medium — RBOX_KEY is not set and bootstrap-failure errors give no next step / leak raw HTTP text.
init — 3/5
Medium — omitting both --new and --workspace silently creates a new workspace; undocumented, and re-running the same script twice by mistake creates two workspaces.
Low — carries over login's "bootstrap"/"kit"/"genesis" jargon with no glossary.
login — 3/5
High — --bootstrap failures show raw HTTP status + response body with no interpretation.
Medium — --bootstrap/--plan help text stacks unexplained jargon ("bootstrap secret", "genesis device") in one line.
Medium — mid-flow poll failures are also raw status codes, inconsistent with the excellent device-limit error two lines away in the same file.
status — 3/5
High — the most likely first-run error a beginner hits (Not inside an rbox workspace) tells them to run rbox track, which doesn't actually sync anything — it should point at setup/init.
Low — "sequence" and "crypto workers: disabled" appear with no plain-language framing.
start — 3/5
Medium — success/rebind messages say "daemon (pid N)" and "bound to" with no explanation.
Medium — a mistyped flag (e.g. --pullonly) silently does nothing instead of erroring — risky for a flag whose whole point is "don't push my changes."
autostart — 3/5
High — missing-subcommand error uses console.log to stdout instead of fail() to stderr, breaking the CLI's own convention used by every sibling group command (device, account, key).
High — unconditionally prints a systemd/loginctl enable-linger note to every Linux user on status, regardless of whether it's relevant to them.
logs — 3/5
High — the actual log lines ("ws error", "pump op quota", "io priority") are internal engineering trace, not written for a first-time reader, even though the command's own flags/help are excellent.
sync — 3/5
High — --allow-mass-delete only covers the pull half of a push+pull sync; there's no way to consent to a push-side mass-delete from sync itself.
Medium — the resulting error always says "run rbox pull --allow-mass-delete" even when the user ran sync.
track — 3/5
High — usage string documents <path> as required; it's actually optional and silently defaults to cwd with no confirmation of what got tracked.
Low — a corrupted .rbox/workspace.json is silently swallowed rather than surfaced.
account — 3/5
Medium — sits directly next to pair/connect in every listing with nothing to stop a beginner running the wrong one for "add my laptop."
Low — "non-revoked OWNER device" is unexplained jargon.
uninstall — 3/5
High — --yes deletes the local E2EE keystore/credentials with zero warning and no recovery-phrase-backup prompt (see top fix #2).
Medium — neither the summary nor the dry-run reassures the user that tracked project files are untouched.
Already solid (4/5, no dedicated section): logout, push, pull, export, untrack, trash, device, subscribe, billing, usage, upgrade, version — each has 1-3 minor, low-severity issues noted in the score table but no structural problems.