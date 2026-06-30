# Design 18 — Support email routing (`support@rbox.to` → Gmail)

> **Implementation: ✅ SHIPPED** (2026-06-30). `support@` (+ `postmaster@`, `security@`) → `brian.a.via@gmail.com` via Cloudflare Email Routing; migrated off Namecheap (eforward MX removed), apex SPF → `_spf.mx.cloudflare.net`, catch-all = Drop, DMARC unchanged (`p=reject`). Verified end-to-end (test message forwarded). Status index: [`README.md`](./README.md).

**Status:** v4 — DESIGN / RUNBOOK. Codex adversarial review converged
v1 **FAIL (11)** → v2 **FAIL (7)** → v3 **FAIL (1)** → v4 applies codex's exact rollback
fix; all prior issues confirmed resolved by codex. Key correction along the way: **doc 16
already exists** and standardizes outbound on **`security.rbox.to`** (not the
`send.rbox.to` v2 invented). Design-only; no code changes. Review log in §12.

**Goal:** inbound mail to `support@rbox.to` (+ a small fixed set of role aliases) is
forwarded to `brian.a.via@gmail.com` via **Cloudflare Email Routing**, configured so it
does not break inbound now or outbound product mail later (doc 16), with a DMARC-correct
(not accidentally broken) story for the eventual "reply *as* support@" path.

> **DECISION (2026-06-29) — outbound provider = MailChannels (not Resend).** This doc
> reconciled to doc 16's then-recommended **Resend** sender on `security.rbox.to`; the
> product call (see doc 16's decision banner) is to **stay all-Cloudflare → MailChannels
> Email API (paid)**. Inbound routing here is **unaffected** (it's pure Cloudflare Email
> Routing on the apex). The only change at implementation: the **`security.rbox.to`
> outbound SPF/DKIM** referenced below shifts from `include:_spf.resend.com` + Resend DKIM
> to **`include:relay.mailchannels.net`** + the **`_mailchannels` Domain-Lockdown TXT** +
> MailChannels DKIM. The apex-vs-subdomain DMARC split and the "no outbound sender on the
> apex SPF" rule **still hold** — only the subdomain's include string changes.

---

## 0. TL;DR

- Use **Cloudflare Email Routing** on the **apex** (`rbox.to`) for *inbound* forwarding.
- This is a **migration**: it *replaces* the **Namecheap email-forwarding** MX/SPF live
  today (§1). The two providers' MX must not coexist; the SPF must never be zero or two
  records. Cutover uses an **atomic MX swap** and a **transient combined SPF during the
  TTL drain** (§5).
- Route a **fixed allow-list** (`support@`, `security@`, `abuse@`, `postmaster@`,
  `dmarc@`; `hello@` optional) to Gmail. **No catch-all forward** — catch-all = **Drop** (§4).
- **DMARC is evaluated on the visible `From:` domain, not the relay.** Two From
  identities exist across docs 18+16: the **apex `@rbox.to`** (humans, `support@`,
  reply-as) and the **subdomain `@security.rbox.to`** (automated product mail, doc 16).
  Each is governed by its own DMARC record (§3).
- **No outbound product sender may be added to the apex SPF.** Doc 16's Resend sender
  lives entirely on `security.rbox.to` (its own SPF `include:_spf.resend.com` + Resend
  DKIM + its own DMARC). Apex SPF authorizes **only** Cloudflare's SRS forwarder (§3.1).
- "Reply *as* `support@rbox.to`" is **out of scope** and non-trivial: it needs outbound
  SMTP (Email Routing can't send) **and** the ESP must *verify the apex From domain*,
  which has real DNS cost — deferred to doc 16 with options spelled out (§7).
- Cost **free**; limits §8. Controls for routing security-sensitive aliases into a
  personal Gmail in §9.

---

## 1. Current live state (measured 2026-06-29 via `dig`, not assumed)

```
MX  rbox.to            10 eforward1.registrar-servers.com.  10 eforward2…  10 eforward3…
                       15 eforward4…  20 eforward5.registrar-servers.com.
TXT rbox.to            "v=spf1 include:spf.efwd.registrar-servers.com ~all"
TXT _dmarc.rbox.to     "v=DMARC1; p=reject;"
NS  rbox.to            linda.ns.cloudflare.com. / marty.ns.cloudflare.com.
CNAME clerk.rbox.to    frontend-api.clerk.services.   (Clerk FAPI — NOT email)
A   app.rbox.to / api.rbox.to   (Cloudflare-proxied — Pages / Worker)
```

- **Zone is on Cloudflare** → DNS managed in the Cloudflare dashboard / API.
- **Inbound mail is currently Namecheap email forwarding** (`eforward*` MX + `spf.efwd…`
  SPF), imported into the Cloudflare zone. **Enabling Cloudflare Email Routing is a
  migration off Namecheap, not a greenfield add.** Coexisting MX ⇒ split delivery.
- **DMARC is already `p=reject`** with no `sp`/`adkim`/`aspf` tags ⇒ **relaxed alignment,
  subdomain policy inherited as `reject`**. Strict on policy, lenient on alignment. We
  keep `reject` and keep relaxed (§3.2).
- **No DKIM proof of an apex sender — but two empty guessed selectors aren't proof.** We
  checked `clerk._domainkey` and `resend._domainkey` (empty); DKIM selectors are
  arbitrary, so this only disproves those guesses. Confirm "apex sends nothing
  legitimate" via a **DMARC `rua` monitoring window** (§5) + provider inventory. Mitigating
  reality: since DMARC is *already* `p=reject`, any unaligned legitimate apex sender would
  already be failing today — so this change's risk is low, but we still gather aggregate
  data before tightening anything.
- **Clerk does not send from `@rbox.to` today.** `clerk.rbox.to` is the Frontend-API
  CNAME, not a mail host; no Clerk DKIM selector exists. Clerk imposes **no** email-DNS
  constraint now. Future "Clerk custom email domain" is discussed honestly in §3.3.

---

## 2. Why Cloudflare Email Routing
- DNS already on Cloudflare → no new vendor, same control plane.
- Free, no mailbox to run, **SRS** forwarding (fixes SPF on the forwarding hop — §6.3).
- Replaces the opaque Namecheap forwarder with rules we can see, version, IaC (§5.1).
- Accepted trade-off: **inbound/forward-only**; cannot send. Outbound is doc 16's job;
  keeping them separate is deliberate (§7).

---

## 3. Identity model & target DNS layout (the core)

**Governing fact: DMARC is evaluated against the RFC5322 `From:` header domain.** SPF
(envelope `MAIL FROM`) and DKIM (`d=`) matter only insofar as one *authenticates* and
*aligns* with that From domain. **Relaxed** alignment (the apex default) = shares org
domain `rbox.to`; **strict** = exact match.

Two From identities across docs 18 + 16:

| `From:` identity | Used by | Governed by | Auth that must align |
|---|---|---|---|
| **`@rbox.to`** (apex) | humans: `support@`, reply-as (doc 16/Gmail send-as) | `_dmarc.rbox.to` (**`p=reject`**, relaxed) | DKIM `d=rbox.to`, or `d=security.rbox.to` under relaxed |
| **`@security.rbox.to`** (subdomain) | automated product mail (new-device emails) — **doc 16** | `_dmarc.security.rbox.to` (own record, `p=quarantine`→`reject`, `adkim=s; aspf=s`) | Resend DKIM `d=security.rbox.to` + subdomain SPF `include:_spf.resend.com` |

### 3.1 DNS records

| Name | Type | Value | Proxy | TTL | Purpose |
|---|---|---|---|---|---|
| `rbox.to` | MX | `route1.mx.cloudflare.net` (pri auto) | DNS-only* | Auto | Inbound routing |
| `rbox.to` | MX | `route2.mx.cloudflare.net` (pri auto) | DNS-only* | Auto | Inbound routing |
| `rbox.to` | MX | `route3.mx.cloudflare.net` (pri auto) | DNS-only* | Auto | Inbound routing |
| `rbox.to` | TXT | `v=spf1 include:_spf.mx.cloudflare.net ~all` (steady state) | n/a | Auto | **Authorizes Cloudflare's SRS forwarder** (a *sender* path for the apex) |
| `_dmarc.rbox.to` | TXT | `v=DMARC1; p=reject; rua=mailto:dmarc@rbox.to` | n/a | Auto | Anti-spoof + aggregate reporting |
| `security.rbox.to` + `_dmarc.security.rbox.to` | — | **owned by doc 16** (Resend SPF/DKIM/DMARC) | n/a | Auto | **Outbound product mail only** |

\* MX can't be proxied; Cloudflare creates the three `route*` records as **managed/locked**
on enable. Don't hand-edit/duplicate/"tidy" their auto-assigned priorities.

**SPF is *outbound* authorization, not "for inbound" (v1 error, corrected).** The apex
SPF authorizes a *sender* — Cloudflare's SRS forwarder — to use the apex as an envelope
domain when re-sending forwarded mail. We keep it minimal so future outbound product
senders are **forbidden from being merged into it**:

- **Apex SPF authorizes only the Cloudflare forwarder.** No Resend/SES/Clerk includes here.
- **Every outbound product sender uses its own subdomain.** Doc 16's Resend sender is
  entirely on **`security.rbox.to`** (`include:_spf.resend.com`, Resend DKIM CNAMEs, its
  own `_dmarc.security.rbox.to`). The apex SPF and the subdomain SPF are separate records
  that never merge ⇒ inbound forwarding and outbound product mail share **zero** SPF state.
  That is the conflict-avoidance mechanism the brief asked for.
- The **only** exception is the deliberate "reply-as support@" decision (§7), which, if
  taken, knowingly verifies an apex From at the ESP — a cost weighed there, not snuck in.

### 3.2 Apex alignment: keep relaxed (don't "fix" to strict)
We keep the apex `_dmarc.rbox.to` at **relaxed** alignment (its current/default). Reasons:
- It permits a `d=security.rbox.to` DKIM signature to align with `From: support@rbox.to`
  (same org domain) — one viable route for reply-as (§7).
- Setting `adkim=s` would force exact `d=rbox.to`, breaking any subdomain-signed apex
  path. Relaxed is a deliberate choice.
- **Residual risk (state it):** under relaxed alignment, any party that can DKIM-sign for
  `rbox.to` *or any of its subdomains* can author DMARC-passing `From: …@rbox.to` mail.
  Today the only such signer is Resend on `security.rbox.to` (doc 16), which we control.
  Don't delegate `rbox.to` subdomains/DKIM keys to untrusted third parties. (Doc 16's
  subdomain DMARC is itself `adkim=s; aspf=s` — strict — which tightens *its own*
  `@security.rbox.to` mail; that's independent of the apex policy.)

### 3.3 DMARC inheritance + Clerk (read before doc 16 / any Clerk custom email)
`_dmarc.rbox.to` has no `sp=` tag, so `reject` is **inherited by subdomains** lacking
their own DMARC. Implications:
- **`@security.rbox.to` mail** is governed by `_dmarc.security.rbox.to` once it exists (a
  subdomain's own DMARC overrides apex inheritance). Doc 16 ramps it `none`→`quarantine`
  →`reject`. Apex stays `reject` throughout.
- **Reply-as `support@` uses `From: @rbox.to`**, so it is governed by the apex
  `p=reject` **from the first send — no soft ramp.** Doc 16 must prove alignment +
  deliverability before enabling Gmail send-as, or the first reply is rejected (§7).
- **Clerk custom email domain (NOT enabled today) — honest caveat.** If ever enabled,
  Clerk's standard setup places **apex-level** DKIM (e.g. `clk._domainkey.rbox.to`) and a
  `clkmail.rbox.to` host, i.e. it sends as `From: @rbox.to` and signs with an
  **apex-aligned** key. That is *not* a clean isolated subdomain identity — it **widens
  the set of parties that can author `@rbox.to` mail** to include Clerk. Treat enabling it
  as a deliberate apex-trust decision (and, if taken, it must not be merged into the apex
  SPF beyond what Clerk strictly requires). Until then, Clerk uses its own default sending
  domain and touches none of this. Earlier drafts wrongly implied Clerk could be a tidy
  isolated subdomain; corrected here.

For *this* doc (inbound only) the **only** DMARC change is adding `rua` aggregate
reporting; policy stays `reject`.

---

## 4. Aliases & catch-all
Each = an Email Routing **custom-address rule → forward to `brian.a.via@gmail.com`**:

| Address | Keep? | Why |
|---|---|---|
| `support@` | **Yes** | The feature. |
| `postmaster@` | **Yes** | RFC 5321 expects deliverability. |
| `abuse@` | **Yes** | RFC 2142; protects domain reputation. |
| `security@` | **Yes** | `security.txt` / vuln disclosure (§9 controls). |
| `dmarc@` | **Yes — required** | `rua` sink for **both** this doc's apex DMARC *and* doc 16's `_dmarc.security.rbox.to` (`rua=mailto:dmarc@rbox.to`). Because `rua` points here, this alias is **not** optional. |
| `hello@` | **Optional** | Friendly marketing address; add only if the site uses it. |
| `info@`/`sales@` | **No (now)** | Add later on real need. |
| `noreply@` | **No** | An *outbound* identity (doc 16), never a forward target. |

**Catch-all: do NOT forward — action `Drop`.** A forwarding catch-all dumps every
dictionary-attack local-part and all backscatter into Gmail, enables harvesting, adds
spam for zero benefit. Explicit rules give intent + auditability. `Drop` silently
discards; do **not** "reject" (emits abusable backscatter bounces).

---

## 5. Setup runbook — staged, atomic, no mail loss (in order)
Pre-req: Cloudflare account `d1d5680013391ca21665add23eee6426`, zone
`87c953295ffdbffa43f8c38ea1553cb9`, role with **Email Routing edit** + **DNS edit**.
Principle: **prove destination + rules work BEFORE touching MX; swap MX atomically; carry
a transient combined SPF until the old MX caches drain.**

1. **Baseline for rollback.** Export zone DNS (`GET /zones/{zone}/dns_records`). Record
   verbatim the five `eforward*` MX (pri 10/10/10/15/20) and the `spf.efwd…` SPF. With the
   human, **enumerate which addresses Namecheap forwards today** (§11.2) so none are
   dropped.
2. **Add + verify the Gmail destination FIRST.** Email Routing → Destination addresses →
   `brian.a.via@gmail.com`. Cloudflare emails the verification link **directly to Gmail**;
   this does **not** depend on `rbox.to`'s MX, so it works before any MX change (v1 wrongly
   implied it could land in the wrong system — it can't). Click it.
3. **Create rules + catch-all while still on Namecheap MX.** One custom-address rule per
   §4 → the verified Gmail; catch-all → **Drop**. They activate when CF MX goes live
   (step 4), so there is no live-MX-without-rules window.
4. **Atomic MX swap + transient combined SPF (single API batch).** Use the Cloudflare DNS
   **batch** endpoint (`POST /zones/{zone}/dns_records/batch`) to, in one change:
   - **add** `route{1,2,3}.mx.cloudflare.net` MX (Email Routing managed) **and delete** the
     five `eforward*` MX — so the two MX sets never coexist; and
   - **replace** the apex SPF with a **transient combined** record:
     `v=spf1 include:_spf.mx.cloudflare.net include:spf.efwd.registrar-servers.com ~all`
     — exactly **one** SPF record, authorizing **both** the new Cloudflare forwarder and
     the still-draining Namecheap forwarder. (Combined lookups stay well under SPF's 10.)
   **Leave the Namecheap forwarding *service* running** so senders that cached the old
   `eforward*` MX still deliver during the drain.
5. **Verify (§6) while combined SPF is live.**
6. **After the old MX TTL has fully elapsed:** (a) disable Namecheap forwarding at the
   registrar so it can't re-add records; (b) **replace** the transient SPF with the
   steady-state `v=spf1 include:_spf.mx.cloudflare.net ~all` (drop the `spf.efwd` include).
   Always swap SPF as a *replace* so there is never zero or two SPF records.
7. **Add DMARC aggregate reporting only.** Edit `_dmarc.rbox.to` →
   `v=DMARC1; p=reject; rua=mailto:dmarc@rbox.to`. Keep `p=reject`. **No `ruf`/`fo`**
   (forensic reports are noisy/often-unsupported and can carry message content/PII into a
   personal mailbox). Optionally also point `rua` at a DMARC aggregator (free tier) and let
   it run as the §1 monitoring window.
8. **Propagation** (Cloudflare TTLs ~minutes), then re-run §6.

### 5.1 IaC note
Manage via the Cloudflare API (`/zones/{zone}/email/routing/...`) and Terraform
(`cloudflare_email_routing_settings`/`_address`/`_rule`/`_catch_all`). Encode rules in IaC
(not click-ops); leave MX/SPF to the documented batch flow above.

---

## 6. Verification & failure modes

### 6.1 DNS sanity — assert exact counts
```
dig +short MX rbox.to                       # ONLY route1/2/3.mx.cloudflare.net (no eforward*)
dig +short TXT rbox.to | grep -c 'v=spf1'   # MUST equal 1  (0 or 2 SPF = fail/permerror)
dig +short TXT rbox.to                       # during drain: includes both cloudflare+efwd;
                                             # steady state: only include:_spf.mx.cloudflare.net
dig +short TXT _dmarc.rbox.to                # v=DMARC1; p=reject; rua=mailto:dmarc@rbox.to
```

### 6.2 End-to-end delivery
- From an **external** mailbox, send to `support@rbox.to`; confirm arrival in Gmail within
  a minute. Repeat for `postmaster@`/`abuse@`/`security@`/`dmarc@` (+`hello@` if added).
- **Prove catch-all = Drop properly:** send to a random local-part
  (`zzz-nope-$(date +%s)@rbox.to`); confirm over a **longer window (15+ min)** that it does
  **not** deliver, and corroborate with the **Email Routing activity log** showing
  match→drop. Inbox-absence alone is not proof.
- Headers of a forwarded message ("Show original"): expect `spf=pass` on the **SRS**
  envelope (`_spf.mx.cloudflare.net`). **DMARC for the original sender depends on the
  *original* DKIM surviving the hop** (it usually does — Email Routing doesn't alter the
  body — so the original `d=…` DKIM still validates and DMARC can pass *by DKIM*). Do
  **not** expect a universal `dmarc=pass`: a sender that relied on SPF-only (no/!aligned
  DKIM) can show DMARC fail after forwarding; that's inherent to forwarding, not a bug in
  this setup. Spot-check a couple of senders rather than asserting one outcome.

### 6.3 Why forwarding usually isn't flagged as spam (SRS) — and its limit
Naive forwarding breaks **SPF** (original domain's mail arriving from Cloudflare IPs not in
its SPF → fail). Cloudflare uses **SRS**: it rewrites the **envelope return-path** to a
Cloudflare-controlled, SPF-authorized address, so the forwarding hop passes SPF. The
visible `From:` is preserved, so the original message's **DKIM** (unchanged body) is what
carries DMARC alignment for the original sender. **SRS fixes SPF on the hop; it does not
manufacture DMARC pass for the visible From** — that still rides on surviving original
DKIM (or receiver ARC/heuristics). Automatic; spot-verify in headers.

### 6.4 Failure modes
| Symptom | Cause | Fix |
|---|---|---|
| Inbound bounces "no MX" | All MX removed, none added | Re-run the batch (step 4) |
| Some mail lost / split | Old `eforward*` MX still present | Ensure the atomic delete in step 4 applied |
| SPF fails for all senders | 0 or 2 SPF TXT (permerror) | Keep exactly one; use *replace* (steps 4/6) |
| Forwarded sender shows DMARC fail | SPF-only sender, no aligned DKIM survives the hop | Inherent to forwarding; not fixable here |
| Rule "unverified destination" | Step 2 link not clicked | Click the Gmail verification link |
| Mail to old `eforward*` lost | Namecheap service disabled before TTL drain | Re-enable Namecheap until old MX TTL elapses (step 6) |
| First "reply-as support@" rejected | Apex `p=reject`, relay From/DKIM not aligned/verified | doc 16 (§7) |

---

## 7. Reply-from behavior & the outbound boundary (hand-off to doc 16)
Replying in Gmail to a forwarded support email defaults to `From: brian.a.via@gmail.com`
(leaks the personal address). To reply **as `support@rbox.to`** you need outbound SMTP —
**Cloudflare Email Routing can't send** — *and* the ESP must accept the apex From. This is
**out of scope** and genuinely non-trivial; the options (a doc-16 decision):

1. **Verify the apex domain (`rbox.to`) in Resend** so it will accept `From: support@rbox.to`
   and DKIM-sign with an apex-aligned key. Cost: this **adds apex DKIM** (Resend CNAMEs at
   `…_domainkey.rbox.to`) and likely wants `_spf.resend.com` reachable for the apex
   envelope. **Tension with §3.1:** it deliberately widens apex identity to Resend. If
   chosen, add Resend's apex SPF include into the *single* apex SPF record consciously
   (watch the 10-lookup limit) rather than as an accident.
2. **Send support replies from a verified subdomain identity** (e.g.
   `From: support@security.rbox.to`, already verifiable under doc 16's `security.rbox.to`).
   Customers then see a subdomain address — uglier, but **zero apex changes** and fully
   DMARC-clean.
3. **Rely on apex relaxed alignment with a `d=security.rbox.to` signature for an apex
   `From:`** — DMARC-valid (§3.2), **but** only works if the ESP will *send* an apex From
   while signing with the subdomain key. **Many ESPs refuse to send a From domain they
   haven't verified**, so do **not** assume this works — it must be proven with the chosen
   provider before relying on it.

Whichever path: the apex is already `p=reject` with **no ramp**, so **test deliverability
to an external DMARC-enforcing inbox before turning on Gmail send-as**. Stopgap until then:
a signature noting the canonical contact, or accept early replies from the personal address.

---

## 8. Cost & limits
- **Cost: $0.**
- **Limits (per zone):** ≤ **200 routing rules**, ≤ **200 destination addresses** (we use
  ~6 / 1). Message size ~**25 MB**. Forward-only; **no outbound send**; can't forward to an
  address on the same domain (loop guard). Headers/attachments passed; SRS on envelope.
- No mailbox storage; if Gmail is down/over-quota, Cloudflare retries per SMTP queue
  semantics then bounces.

---

## 9. Security & operational posture
- **Spoofing of `@rbox.to`:** mitigated by apex **DMARC `p=reject`** + SPF; this doc keeps
  it and adds `rua`. Alignment is relaxed by deliberate choice (§3.2); the residual risk is
  the set of DKIM signers for `rbox.to`/subdomains (today only our Resend on
  `security.rbox.to`).
- **Inbound forwarding authorizes no one to send as us.**
- **Phishing into the support inbox:** forwarded mail is open-internet; normal Gmail
  filtering applies. Add a Gmail filter labeling `to:(*@rbox.to)`.
- **Catch-all = Drop** shrinks the attackable/harvestable surface.
- **Controls for security-sensitive aliases routed to a personal Gmail (codex #11).**
  `security@`, `abuse@`, and DMARC `rua` land in `brian.a.via@gmail.com` — acceptable for a
  solo founder *only* as a stopgap with:
  - **Hardware-key/app 2FA mandatory** on that Gmail (it is now a security-incident channel).
  - **Ownership + SLA:** `security@` is the disclosure address (publish in
    `/.well-known/security.txt`); commit to an ack window (e.g. 72h).
  - **Triage/retention:** Gmail filter + label per alias.
  - **Migration trigger:** before public launch / second teammate, move these to a
    **shared/role mailbox** (Workspace group) so access survives the founder and isn't tied
    to one personal account's recovery.
- **Least privilege:** the setup token needs only Email Routing + DNS edit on this one zone.

---

## 10. Rollback — mirror the cutover, including the SPF drain (no split-delivery, no SPF gap)
The mistake to avoid: do **not** disable Cloudflare Email Routing and flip to
Namecheap-only SPF in one shot. Senders that cached the **Cloudflare** `route*` MX will
keep delivering through Cloudflare's SRS forwarder until that record's TTL expires — if
Email Routing is off they bounce, and if it's left on it is no longer SPF-authorized once
the Cloudflare include is gone. So rollback is staged exactly like cutover:

1. **Re-enable the Namecheap forwarding service** at the registrar first.
2. **MX-swap batch (single `POST …/dns_records/batch`):** **add** the five `eforward*` MX
   (pri 10/10/10/15/20) and **delete** the Cloudflare `route*` MX, **and replace** the
   apex SPF with the **transient combined** record
   `v=spf1 include:spf.efwd.registrar-servers.com include:_spf.mx.cloudflare.net ~all`
   (one SPF record, authorizing **both** forwarders during the drain). **Keep Cloudflare
   Email Routing + its rules ENABLED** for now so senders still holding the cached
   Cloudflare MX continue to be forwarded *and* remain SPF-authorized.
3. **After the Cloudflare `route*` MX TTL has fully drained:** replace the SPF with the
   Namecheap-only steady state `v=spf1 include:spf.efwd.registrar-servers.com ~all`
   (single replace — never 0/2 records) and **only then disable Cloudflare Email Routing**.
4. DMARC `rua` reverts by restoring `v=DMARC1; p=reject;`.
A single bad *rule* (not DNS) is fixed by disabling that one rule — no DNS change.

---

## 11. Open questions for the human
1. Alias set: add `hello@` now? (`dmarc@` is **required**, not optional — `rua` targets it.)
2. **Which addresses does Namecheap forward today?** Enumerate before cutting `eforward*`
   MX (step 1) so nothing is silently dropped.
3. Reply-as `support@rbox.to` at launch — and if so, which §7 path (apex-verify in Resend,
   subdomain `@security.rbox.to`, or prove the subdomain-signed-apex path with Resend)? Or
   forward-only for v1?
4. Point DMARC `rua` at a third-party aggregator (free tier) in addition to `dmarc@rbox.to`?
5. Confirm doc 16's sending subdomain stays `security.rbox.to` (this doc assumes it; if it
   becomes a generic `mail.`/`send.`, update §3).

---

## 12. Codex adversarial review log
Converged over four rounds; every finding was real and is reflected in the body above.

- **v1 → FAIL (11).** Fatal DMARC-identity confusion (treated apex SPF/DMARC as "inbound
  only" while routing apex-From reply-as through a subdomain DKIM; the `_dmarc` subdomain
  ramp was irrelevant to an apex `From:`). SPF mislabeled as inbound. Lossy cutover order
  (deleted Namecheap before destination/rules verified). Wrong claim that destination
  verification could land in the wrong system. `ruf` to personal Gmail. "No DKIM selectors"
  overclaimed. Clerk custom-email hand-waved. Weak verification (text-presence, "didn't
  arrive in a minute"). No ops controls for security-sensitive aliases.
  → **Resolved:** two-identity model on the `From:` domain (§3); SPF reframed as outbound
  authorization; staged runbook (destination+rules first); removed the verification claim;
  dropped `ruf`/`fo`; qualified the DKIM-selector claim with a `rua` monitoring window;
  added exact-count `dig` asserts + activity-log proof for catch-all; added §9 controls.
- **v2 → FAIL (7).** SPF drain still unsafe (no SPF authorization for the still-draining
  Namecheap forwarder). Rollback re-added Namecheap MX *before* removing Cloudflare's
  (deliberate split delivery). Clerk example `clk._domainkey.rbox.to` is apex DKIM, not a
  clean subdomain. Reply-as assumed an ESP will send an apex `From:` it hasn't verified.
  **doc 16 actually exists and uses `security.rbox.to`, not the invented `send.rbox.to`.**
  SRS overclaimed universal `dmarc=pass`. `dmarc@` was both required and optional.
  → **Resolved:** transient combined SPF during drain + steady-state trim (§5); atomic
  MX-swap batch; honest Clerk apex-DKIM caveat (§3.3); reply-as rewritten with three
  provider-real options + the ESP-verification cost (§7); reconciled entirely onto doc 16's
  `security.rbox.to`/Resend records; SRS scope corrected to "fixes SPF on the hop, DMARC
  rides surviving original DKIM" (§6.3); `dmarc@` marked required.
- **v3 → FAIL (1).** Rollback still flipped to Namecheap-only SPF / disabled Email Routing
  while the Cloudflare MX was still cached → bounce-or-unauthorized window.
  → **Resolved (v4):** rollback now mirrors the cutover — combined SPF + Email Routing kept
  live through the Cloudflare MX TTL drain, then trim SPF and disable (§10). Codex confirmed
  all other prior issues resolved.
