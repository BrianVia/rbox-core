# REVIEW-132 — public changelog pipeline

Review rounds for design 132. Alignment requires the release publisher, Worker
gateway, and static Astro page to share one bounded feed contract and to fail
safely across partial, concurrent, stale, and hostile-input cases.

## Round 1

**Release reviewer: NEEDS WORK.** The draft overstated manifest/signature
atomicity, omitted the mutable binary aliases and their installer consistency
window, did not define historical direct bullets, left bounds numeric-free, and
did not describe recovery after the one-day artifact expires.

**Worker reviewer: NEEDS WORK.** Separate tag workflows could roll mutable R2
objects backward; CORS on error paths and cache headers were underspecified; and
the generator, Worker, and browser could disagree on unspecified limits.

**Website reviewer: NEEDS WORK.** A committed static snapshot would remain stale
for crawlers, whole-list replacement would harm focus/hash behavior, the runtime
fetch and feed validation were insufficiently bounded, rendering could create an
XSS seam, markup/anchors needed stronger semantics, and navigation coverage was
incomplete.

**Resolution:** These findings described a much larger system than the product
needed. The owner explicitly chose a simpler trust boundary: `CHANGELOG.md` is
reviewed repository content, uploaded unchanged, streamed unchanged by the API,
and rendered only during the trusted Astro build. The revised design removes the
custom JSON schema and all browser-side parsing/reconciliation. A Pages deploy
hook keeps the static page fresh, while a committed snapshot covers local builds
and transient fetch failures. Release ordering, caching, recovery, navigation,
and raw-HTML escaping remain explicit.

## Round 2

**Release reviewer: NEEDS WORK.** The simplified pipeline still needed a minimal
tag-to-first-release-heading check and protection against concurrent/out-of-order
tag workflows rolling the mutable changelog backward.

**Website reviewer: NEEDS WORK.** Rendering the source title through
`LegalLayout` would produce two H1s, the empty Unreleased heading added noise,
and production fallback after a failed CDN fetch could leave the page silently
stale indefinitely.

**Resolution:** The design now adds only small guards: first-heading validation,
serialized/monotonic mutable publication, and a final live-manifest equality
check. Astro consumes the source title and empty Unreleased heading, owns stable
release anchors, uses the snapshot only outside Cloudflare Pages, and fails a
Pages build if the authoritative Markdown cannot be fetched.

## Round 3

**Release reviewer: ALIGNED.** The first-heading gate and serialized, monotonic
publication bind the uploaded Markdown to the live manifest without adding a
second changelog format.

**Website reviewer: ALIGNED.** The page has one H1, deterministic release
anchors, fail-visible production freshness, escaped HTML and safe links, and
remains static/indexable without a browser protocol.

Both reviewers agree implementation may proceed against design 132.
