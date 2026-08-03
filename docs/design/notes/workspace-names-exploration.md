# Workspace names in the customer dashboard — design of record

**Status:** DECIDED + IMPLEMENTED (founder-locked). This was originally a feasibility note;
the "Decision" section below is now the design of record. The analysis that follows it is
retained as rationale.
**Scope:** the CUSTOMER dashboard (`app.rbox.to` = `apps/web`), NOT the admin cockpit.
**Date:** 2026-07.

---

## Decision (LOCKED)

Ship a variant of **Option 2 (user-chosen nickname)** — opt-in, default-off — with these
founder-locked rules:

1. **Opt-in, default-off, server-visible.** A workspace MAY carry an optional plaintext
   `name` the SERVER stores and the customer dashboard renders. This is a *deliberate,
   consensual metadata trade* (the server learns the label). Absent a name, behavior and
   copy are exactly as before (private, "root").
2. **Set once at create by the first host; first-writer-wins.** The workspace row is
   `INSERT`ed exactly once (by the creating device at `rbox init`), so the name is set on
   that single insert. **No web editing, no `PATCH` route** — the web write-gate stays fully
   closed. Later devices joining an existing workspace never set it.
3. **CLI UX.** At `rbox init`, when interactive (TTY), PROMPT for a name pre-filled with the
   `~`-collapsed local root (e.g. `~/conductor/workspaces` from `WorkspaceConfig.rootPath`),
   with a one-line notice that the name is visible in the web dashboard (server-side), NOT
   end-to-end encrypted. Enter accepts the suggestion; editing changes it; clearing it skips
   (→ no name, stays private). When NON-interactive OR `--name` absent → send NO name. An
   explicit `rbox init --name "<label>"` flag supports scripted opt-in.
4. **`name` is opaque user text, not a path.** Sanitize (strip control chars/newlines) and
   bound length (≤128). `project_id` stays `"root"` — the name is a SEPARATE field.
5. **Copy must be honest, per-row.** Unnamed rows keep the strong private claim
   ("rbox can't see your folder names — names live only on your devices"); named rows show a
   softer, truthful line ("name is visible to rbox; contents stay end-to-end encrypted").
   Designs 17 §4.2 and 30 §2.1 updated to match.

Implementation landed:
- Schema: `apps/api/migrations/0019_workspace_name.sql` (`ALTER TABLE workspaces ADD COLUMN name TEXT`, nullable).
- Server: `createWorkspace` (`apps/api/src/authz.ts`) accepts + sanitizes + stores `name`;
  `accountWorkspaces` (`apps/api/src/auth.ts`) returns it. `sanitizeWorkspaceName` +
  `MAX_WORKSPACE_NAME` guard length/control chars server-side (defense-in-depth).
- CLI: `--name` flag + interactive prompt (`src/cli/init-cmd.ts`); pure helpers
  `collapseHome` / `sanitizeWorkspaceName` + name threaded onto the `new` choice
  (`src/cli/init-plan.ts`); `createRemoteWorkspace` sends `&name=` (`src/cli/remote.ts`).
- Web: `apps/web/src/routes/devices/+page.svelte` renders `name ?? projectId` with per-row copy.

The founder open-questions below were resolved as: (1) user-chosen string, opt-in;
(2) opt-in / default stays private; (3) yes — documented, user-controlled carve-out;
(4) yes — per-row copy, designs 17/30 updated; (5) defer web editing (write-gate stays closed).

---

## The central tension (read this first)

rbox is a **zero-knowledge** system by deliberate design. `docs/design/12-full-e2ee.md:370-372`
lists, in plain language, what is "Hidden from the server/operator (the goal)": *file contents;
file names & paths; the directory tree/structure; per-file sizes…; git refs/branch names/commit
messages; the manifest entirely.* That is not an oversight — it is the product's core promise.

The customer web UI is a **non-E2EE identity**. A browser session carries a short-lived `kind:"web"`
token, and the default-deny route gate (`apps/api/src/worker.ts:251-257`, allowlist at
`worker.ts:427-443`) never lets a web token reach `POST /v1/workspaces` or any `/v1/keys/*`
surface. So the browser holds **no KEK and can do no crypto** (this is the P4 credential-kind
gating). It can only render what the **server already sees in plaintext**.

Consequence, and it's the whole point:

> To show a real folder/path name in the web UI, **the server must learn that name in plaintext.**
> An *encrypted* label does not help — the browser can't decrypt it. Every option that makes the web
> dashboard show something better than "root" is a **deliberate metadata trade**: the server (and
> anyone who can subpoena or breach it) learns something about the user's local directory structure.

And the current UI copy — *"rbox can't see your folder names — names live only on your devices"*
(`apps/web/src/routes/devices/+page.svelte:182`, spec'd at
`docs/design/17-account-devices-workspaces.md:262`) — **becomes FALSE** under any server-visible-name
option. If we ship a name, we must change that sentence. Non-negotiable; leaving it up would be a lie.

---

## Where "root" actually comes from (it is not a name — it's `project_id`)

The label the screenshot shows as "root" is the workspace's **`project_id`**, a primary-key
component, rendered verbatim. Trace:

1. **Default value.** The CLI defaults the project to the literal string `"root"`:
   `src/cli/init-plan.ts:109` (`const project = flags.project ?? "root"`), also
   `src/cli/track-cmd.ts:33`. `config.ts:17` documents it: *"Single project for now ('root' = the
   whole linked tree)."* There is exactly one project per workspace today, always named `root`.

2. **Create call.** The CLI (a **durable** token) calls
   `createRemoteWorkspace(baseUrl, token, project)` → `POST /v1/workspaces?project=root`
   (`src/cli/remote.ts:399-406`). The API handler defaults the same way:
   `createWorkspace(env, p, url.searchParams.get("project") ?? "root")` (`apps/api/src/worker.ts:285`).

3. **Storage.** `createWorkspace` (`apps/api/src/authz.ts:75-84`) inserts a row into
   `workspaces(workspace_id, project_id, account_id, created_at)`. Table def:
   `apps/api/migrations/0005_gc.sql:8-14` (PK `(workspace_id, project_id)`); `account_id` added in
   `0006_tenancy.sql:48`. **There is no `name` column.** The server never receives one.

4. **Read.** `GET /v1/account/workspaces` (`apps/api/src/auth.ts:644-668`) returns
   `{ workspaceId, projectId, createdAt }`. Its own doc-comment (`auth.ts:642-643`) is explicit:
   *"the server holds NO folder name/path; `projectId` is a PK component returned verbatim."*

5. **Render.** `apps/web/src/routes/devices/+page.svelte:199` renders `{w.projectId}` as the label
   (type: `apps/web/src/lib/api.ts:104-107`). Since `projectId` is always `"root"`, every workspace
   shows "root". That's the bug-that-isn't: it's rendering the truth the server has.

**The device DOES know the real path.** `WorkspaceConfig.rootPath` (`src/cli/config.ts:20-21`) is the
resolved absolute local root — but it is explicitly *"Local-only … NEVER synced"* (`config.ts:10`).
The path exists on the client at create time (`init-cmd.ts` writes `rootPath: plan.root` at ~line 114,
right after the create call at ~line 104). So attaching a name at create is a small, natural change —
the data is already in hand.

**First-host semantics fall out for free.** The workspace row is `INSERT`-ed exactly once, by the
device that runs the "new" branch (`init-cmd.ts:103` — `kind === "new"` creates; later devices take
the `"join"`/adopt-id branch and never insert). So "the host that first started syncing" == "the
creating device" == "the one write of the row." First-writer-wins is the natural behavior; we just
have to make sure the API `createWorkspace` sets `name` on that single insert and no later call
overwrites it (there is no later call today).

---

## Options

Effort note up front: **the code is uniformly Small.** A nullable column + one migration, one CLI
param, one API field in/out, one web fallback expression. The weight is entirely the **privacy
decision**, not the diff. Don't let anyone estimate this as "L because privacy" — the privacy cost
is real but it is a *decision*, not *work*.

### Option 1 — Auto server-visible path label
CLI sends `rootPath` (absolute, or `~`-collapsed) as a plaintext `name` on create; server stores it
on the `workspaces` row; web shows `name ?? projectId ?? 'root'`. First-writer-wins per above.

- **Schema:** `ALTER TABLE workspaces ADD COLUMN name TEXT` (new migration, nullable). **S**
- **CLI:** append `&name=<encoded rootPath>` in `createRemoteWorkspace`. **S**
- **API:** `createWorkspace` reads `name` param, binds it in the INSERT; `accountWorkspaces` SELECTs
  and returns it. Add `name` to the web-token-readable projection only (never widen the write gate). **S**
- **Web:** render `w.name ?? w.projectId`. **S**
- **Privacy delta: HIGHEST.** The server durably learns the user's real filesystem layout
  (`/Users/brian/conductor/workspaces/foo`), which leaks username, org/project names, and directory
  structure — precisely the "names & paths / directory tree" that design 12 promises to hide. `~`-collapsing
  removes the OS username but keeps the structure. This is a genuine narrowing of the zero-knowledge claim.

### Option 2 — User-chosen nickname (recommended, see below)
User sets a deliberate label — CLI flag `rbox init --name "Conductor workspaces"`, and/or editable in
web later. Server stores the chosen string; it does **not** auto-ingest the real path.

- **Schema/API/Web:** identical to Option 1 (**S** each).
- **CLI:** add a `--name` flag; pass through on create. **S** (an editable-in-web variant needs a new
  `PATCH /v1/workspaces/:id` route added to the web-token allowlist — still **S**, but that's the one
  place the write gate widens, so gate it to owner/admin role and validate length.)
- **Privacy delta: MEDIUM-LOW, and it's the user's informed choice.** The server sees a string the
  user typed on purpose. A privacy-conscious user types "Work laptop"; a careless one pastes their
  path — but that's consent, not silent exfiltration. Materially better story than Option 1: we can
  honestly say "rbox shows the name you chose," not "rbox now records your folder path."

### Option 3 — Encrypted label (REJECTED — analysis)
Store an encrypted label the way blobs/manifests are E2EE. **This cannot achieve the stated goal.**
The web identity has no KEK and the route gate blocks `/v1/keys/*` (`worker.ts:427-443` — no keys
entry), so the browser physically cannot decrypt it. It would render as ciphertext or a "🔒 encrypted"
placeholder — strictly worse than "root."

- **Worth noting:** the *CLI* (which has the KEK) COULD decrypt and display a real name locally — e.g.
  a future `rbox status` / `rbox ls` that shows the friendly name device-side. That preserves
  zero-knowledge perfectly. But it does **nothing for the web dashboard**, which is the actual ask.
  Park it as a device-side nicety, not a solution here.

### Option 4 — Basename-only / minimal leak
Server stores only the last path component (`workspaces`) instead of the full path.

- **Effort:** same **S** (the CLI sends `path.basename(rootPath)` instead of the whole thing).
- **Privacy delta: LOWER than Option 1, still a leak.** "workspaces", "conductor", "src" — a basename
  can still be a project/client name. And it's often useless-to-ambiguous: three workspaces all named
  `workspaces` or `repo` disambiguate no better than "root." You pay a privacy cost for weak utility.
  Weak middle ground; if we're leaking at all, Option 2's intentional string dominates it.

### Option 5 — Do nothing (the honest baseline)
Keep rendering `projectId` ("root"), keep the zero-knowledge copy truthful.

- **Effort: none.** **Privacy delta: none** — the promise stays intact.
- **Cost:** the real UX papercut the founder flagged (two indistinguishable "root" rows) remains.

---

## Recommendation

**Ship Option 2 (user-chosen nickname), opt-in, defaulting to the current private behavior.**

Rationale:

1. **It's the right privacy/UX balance.** It solves the "everything says root" papercut while keeping
   the leak *consensual and minimal* — the server sees a string the user chose, not their filesystem.
   Option 1's auto-path is the founder's instinct, and it's the most convenient, but it silently
   converts a hard zero-knowledge guarantee into "we record your paths." That's a big promise to spend
   on a label. If the founder wants auto-path convenience, offer it as an explicit `--name "$(pwd)"`
   the user opts into — same outcome, honest framing.

2. **Opt-in, default stays "root."** Users who never set a name keep today's exact behavior and today's
   exact (true) copy. Only a workspace with a non-null `name` renders it AND swaps the copy for that row.

3. **Copy MUST change when a name is present.** Replace, for named workspaces, *"rbox can't see your
   folder names — names live only on your devices"* with something true, e.g. *"Showing the name you
   set for this workspace. rbox still can't see your files or folder contents."* Keep the original copy
   for unnamed ("root") workspaces. Update the source spec at
   `docs/design/17-account-devices-workspaces.md:262` and `docs/design/30-device-management.md:205` too,
   or they'll drift.

4. **First-writer-wins, set once at create.** Matches "first host to sync" cleanly (single INSERT) and
   avoids a multi-device last-writer race. If we later add web-editing, that's the deliberate exception —
   gate it owner-only.

Total effort: **S** across schema (1 nullable column + migration ~`0019_workspace_name.sql`), CLI
(`--name` flag), API (accept + project into the web-readable response), web (`name ?? projectId`
fallback + conditional copy). Realistically a half-day of code, plus a migration. **The estimate is
dominated by the decision, not the diff.**

---

## Open questions for the founder

1. **Auto-path vs nickname?** I recommend nickname (Option 2). Auto-path (Option 1) is more convenient
   but silently records users' folder paths on the server — do you want to spend the zero-knowledge
   promise on that, or make it an explicit opt-in string?
2. **Opt-in vs default-on?** I recommend opt-in (default stays the private "root"). Default-on means
   every existing and future user's paths/labels start flowing to the server unless they think to turn
   it off — the wrong default for a privacy product. Agree?
3. **Is the "zero-knowledge on names" promise worth preserving?** Any server-visible-name option
   narrows it from "we can't see names/paths" to "we can't see names/paths *unless you set one*." Are
   you comfortable making that a documented, user-controlled carve-out (fine) vs. an unconditional
   change (not fine)?
4. **Does the UI copy change?** It has to for named workspaces — the current sentence would be false.
   Are you OK with per-row copy (private "root" rows keep the strong claim; named rows show a softer,
   truthful one), and updating designs 17/30 to match?
5. **Web-editing later?** Set-once-at-create (CLI only) keeps the write gate closed. Editing the name
   in the browser requires a new owner-gated `PATCH /v1/workspaces/:id`. Want that now, or defer?
