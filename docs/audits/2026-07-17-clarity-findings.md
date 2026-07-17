## 1 fresh-setup
The Step-1 account choice screen is genuinely stupidly simple (new-vs-existing, clear counter), but the surrounding surfaces are not: the bare `rbox` help text is a dense CLI reference full of sync/crypto/git jargon with no plain-language explanation of what the tool does, and the two screens right before the browser handoff both leak jargon ('account bootstrap secret', '[input is masked]') or an outright broken-looking artifact (the authorization link prints as a schemeless relative path, "/cli-login?code=...", which cannot actually be typed into a browser). The single highest-value fix is to render the full absolute URL on the device-authorization screen and drop the raw 'bootstrap secret' language from the sign-up prompt — the identity-conveying step (Step 1) is otherwise the strongest screen in the flow.

## 2 second-device-pairing
The second-device pairing flow is NOT stupidly simple: the account/pairing screens (Steps "new vs existing account", "how to authorize", "paste token") are genuinely plain-language and would work for a nontechnical person, but the workspace-creation half repeatedly leaks raw internal IDs (dev_..., acct_...) into status lines, tells the user mid-wizard to go run the very wizard they're already in, and culminates in a gitignore/.rboxignore question dense with unexplained git and CLI jargon. Most damaging: accepting the default answer on that gitignore question reliably crashed the tool outright with no error message, 3 times in a row, meaning the flow could not be verified to reach completion. The single highest-leverage fix would be handling/explaining that crash (or at minimum surfacing a real error) and rewriting the gitignore-handling screen in plain terms — everything else is comparatively minor wording polish.

## 3 help-surfaces
This is a power-user reference screen, not an introduction for nontechnical people. The tagline itself ("dev-aware sync (end-to-end encrypted)") and roughly a dozen terms (workspace, daemon, background sync, pull-only, bootstrap, kit, RBOX_KEY, deferred Git repos, head pin, re-baseline, mass-delete guard, agent/CI sync key) assume the reader already knows what rbox is. The single highest-value fix: add one plain sentence above the command table answering "what does this tool do and why would I run it" in human terms (e.g. "keeps a folder in sync across your computers, encrypted so only you can read it"), and split or annotate the DEVICES & ACCOUNT section so `pair`/`connect`/`device`/`account`/`key` read as one coherent "add another computer" story instead of five parallel technical primitives.

## 4 status-and-logs
The interactive `rbox setup` wizard is genuinely clear plain-English prose (a nontechnical user could follow it end to end, including the git/encryption caveats it does surface). But `rbox status` and especially `rbox logs` fall apart: status mixes friendly sentences with raw internal identifiers (workspace/account/device hashes, "sequence 0", "seq 0"), a scary red-circle icon paired with billing jargon ("no active plan"), and unexplained terms like "locking: ok" and "git-sync: 0 repos synced". `rbox logs` is not a status message at all — it is an unfiltered daemon debug stream (bootId, pid, wire=0B, dc:off, queueMs p50/p95/max, rss) that a nontechnical user pointed at by the status screen's own "view logs with: rbox logs" hint would find completely opaque. The single highest-value fix: stop telling ordinary users to run `rbox logs` for basic troubleshooting — that command is a developer/support tool and reads as an error dump, not an explanation.

## 5 gitignore-step
No — this surface is not stupidly simple; it is written entirely in git/rbox insider vocabulary and never once translates the one thing a nontechnical person actually needs to know: that choosing 'recommended' keeps things like passwords and API keys out of rbox by default. The single highest-value fix is rewriting the gitignore choice screen to name the concrete stakes in plain words ("keeps things like passwords out of rbox") instead of relying on the reader already knowing what 'gitignored' and 'untracked' mean — and fixing the misleading '(end-to-end encrypted)' parenthetical that implies only one option is safe. The `rbox ignore --list` output should also get a plain-English one-line summary above the raw pattern dump, since right now the reassurance that secrets (.env, *.pem, id_rsa) are auto-protected is buried unlabeled in 63 lines of ecosystem trivia.

## 6 error-messages
Every error correctly states what went wrong, but roughly half lean on a code-literal "expected format" string (`rbox-pair_&lt;id&gt;.&lt;secret&gt;`, `rbox login --bootstrap &lt;secret&gt;`) instead of a plain-English instruction, and jargon like "redeem id," "device," and "pipe it" assumes CLI/git-adjacent vocabulary a lawyer or designer would not have. The single highest-impact fix: replace format-string "expected X" errors with an instruction sentence ("Copy the whole token your teammate sent you and paste it again") and always end with a concrete next action, especially after the setup wizard's pairing-token step, which currently prints an error and stops with no visible way to retry.

## 7 approve-code-screens
The account-creation and browser-handoff copy up through the approval-code screen is genuinely clear for a nontechnical reader — plain sentences, an obvious action ('Press Enter to sign up in your browser'), and a URL to visit. The one real problem is the terminal waiting-for-approval state: once you land there, nothing on screen tells you how to cancel or go back, and in practice the harness's standard interrupt keys did nothing visible, which would leave a real user staring at a countdown with no stated way out. Fixing that one screen (add a printed 'press any key / Ctrl-C to cancel' line, and make sure it actually works) would close the biggest gap.

## 8 recovery-and-menus
The account step is mostly navigable by a nontechnical person (the top-level "new here vs already have an account" choice reads fine), but two things break the "stupidly simple" bar: the three device-authorization options are not distinguishable in plain language (Sign in via browser and Approve a code render the exact same code+link screen, so a user can't predict which to pick), and the pairing-token / bootstrap-secret inputs assume the user already possesses CLI jargon (a "pairing token", an "account bootstrap secret", an encryption key) with zero inline explanation of where these come from or what they look like. The single biggest fix would be to give the three authorize-menu options genuinely distinct, plain-English descriptions (e.g., "use a link from another one of your devices" vs "type in a short code"), and to make the masked pairing-token field fail with a visible, human error message instead of silently killing the session when given bad input.


# CONFUSING SCREENS
- [1 fresh-setup] rbox — dev-aware sync (end-to-end encrypted)  GETTING STARTED   setup ... guided
  REWRITE: 
- [1 fresh-setup] ✔ Are you new here, or do you already have an rbox account? Create a new account
  REWRITE: Press Enter to sign up in your browser. (Have an invite code from your team instead? Type it here.)
- [1 fresh-setup] To authorize this device, visit:      /cli-login?code=[REDACTED]      (or run `r
  REWRITE: To finish signing up, open this link (we'll also try to open it for you):      https://<host>/cli-lo
- [2 second-device-pairing] device authorized + encryption enrolled: dev_188de2557fd10f3ffa2c557c05d00d81 Ru
  REWRITE: You're signed in on this device. Continue below to set up your first workspace here.
- [2 second-device-pairing] ? Workspace id to sync
  REWRITE: Which workspace? (Find its ID on the dashboard, or under the folder's name where it was first set up
- [2 second-device-pairing] Signed in and enrolled (acct_1b96276cda2a7544) — skipping account setup.
  REWRITE: You're already signed in — skipping account setup.
- [2 second-device-pairing] ? How should rbox handle gitignored files? ❯ Skip gitignored untracked files (re
  REWRITE: Some files (like passwords or temporary build files) are usually excluded from backups. Skip those, 
- [2 second-device-pairing] [crash: tmux server exits with no on-screen message] — reproduced 3 times, inclu
  REWRITE: 
- [3 help-surfaces] rbox — dev-aware sync (end-to-end encrypted)
  REWRITE: 
- [3 help-surfaces] SYNCING   start [path] [--pull-only]  start background sync for this workspace  
  REWRITE: 
- [3 help-surfaces] track [path] [--workspace <id>] [--respect-gitignore] [--new-device]  bind a dir
  REWRITE: 
- [3 help-surfaces] ignore <glob> | --list | --respect-gitignore <on|off> | --purge [--yes] [--path 
  REWRITE: 
- [3 help-surfaces] DEVICES & ACCOUNT   pair  create a token to add another machine   connect  add t
  REWRITE: 
- [3 help-surfaces] recover [path] [--yes] [--repair-chain] [--allow-mass-delete]  clear the local h
  REWRITE: 
- [3 help-surfaces] key <status | backup | genesis | recover | create-ci | materialize | list | revo
  REWRITE: 
- [3 help-surfaces] Run `rbox <command> --help` for details on any command. Exit codes: 0 ok, 1 erro
  REWRITE: 
- [3 help-surfaces] setup — guided onboarding: account → workspace → start syncing  usage: rbox setu
  REWRITE: 
- [3 help-surfaces] connect — add this machine from a pasted token (stdin)  usage: rbox connect  fla
  REWRITE: 
- [3 help-surfaces] ignore — manage .rboxignore  usage: rbox ignore <glob> | --list | --respect-giti
  REWRITE: 
- [4 status-and-logs] How should rbox handle gitignored files? > Skip gitignored untracked files (reco
  REWRITE: Some files your project's tools (like git) are already set up to ignore — should rbox skip those too
- [4 status-and-logs] workspace ~/notes-project @ /tmp/rbox-ux/flow4status/owner/notes-project (ws_0b6
  REWRITE: Drop the hex ids from the default view (put them behind a --verbose flag), replace 'locking: ok' wit
- [4 status-and-logs] ⛔ no active plan · run `rbox subscribe`   remote: seq 0 · live via daemon (10s a
  REWRITE: No paid plan yet — your files are saved locally but not backed up to rbox's servers. Run `rbox subsc
- [4 status-and-logs] 2026-07-17T00:57:57.914Z rbox daemon starting: /tmp/... workspace ws_0b6488a0d0e
  REWRITE: Ship a 'friendly' log view by default (e.g. 'Checked your files — nothing to sync yet' / 'Paused: no
- [4 status-and-logs] {"workspace":{"id":"ws_0b6488a0d0e24c8f9d9b6d170b92662b", ... "health":"outofsto
  REWRITE: 
- [5 gitignore-step] a workspace name is OPTIONAL and shown in the web dashboard (visible to rbox, se
  REWRITE: Give this folder a name (optional). Unlike your files, this name is NOT private — rbox's servers can
- [5 gitignore-step] ? How should rbox handle gitignored files? ❯ Skip gitignored untracked files (re
  REWRITE: Some files in this folder are marked 'don't save to version control' (in a file called .gitignore) —
- [5 gitignore-step] ✗ initial push failed  ✗ rbox: No active plan — run `rbox subscribe`.
  REWRITE: 
- [5 gitignore-step] respectGitignore: on / ignore rules (precedence: builtin → .gitignore → .rboxign
  REWRITE: A short header stating in plain terms: 'These types of files are never synced, including your passwo
- [6 error-messages] How do you want to authorize this machine? / Paste a pairing token / Sign in via
  REWRITE: 
- [6 error-messages] After pasting malformed token: '✗ rbox: malformed pairing token (expected `rbox-
  REWRITE: 
- [6 error-messages] ✗ rbox: no pairing token provided (run `rbox pair` on a signed-in machine, then 
  REWRITE: 
- [6 error-messages] ✗ rbox: malformed pairing token (invalid redeem id)
  REWRITE: 
- [7 approve-code-screens] Waiting for approval (expires in 600s)...
  REWRITE: 
- [8 recovery-and-menus] How do you want to authorize this machine? ❯ Paste a pairing token   Sign in via
  REWRITE: 
- [8 recovery-and-menus] ? Paste pairing token [input is masked]
  REWRITE: 
- [8 recovery-and-menus] Press Enter to sign up in your browser (advanced: enter an account bootstrap sec
  REWRITE: 
