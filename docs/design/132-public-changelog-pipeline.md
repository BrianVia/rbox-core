# Public changelog pipeline

## Goal

Publish the existing `CHANGELOG.md` automatically after every successful CLI
release and render it at `https://rbox.to/changelog/`.

`rbox-core/CHANGELOG.md` is the only authored source. It is trusted release
content reviewed like source code; there is no second release-note format.

## Flow

```text
successful CLI release
  -> upload tagged checkout's CHANGELOG.md to releases/changelog.md in R2
  -> API Worker streams GET /changelog.md as text/markdown
  -> POST the rbox-home Cloudflare Pages deploy hook
  -> Astro build fetches and renders the Markdown at /changelog/
```

The upload is deliberately the final release publication step, after the signed
manifest and signature are live. A failure leaves the previous changelog live
and fails the workflow; rerunning the idempotent publish job repairs it.

Two small guards keep that mutable file honest:

- the build requires the tag version to be the first released heading after
  `[Unreleased]` in `CHANGELOG.md`;
- release publication uses a non-cancelling concurrency group, fetches the live
  manifest before any mutable writes, and refuses a lower SemVer candidate. Just
  before the changelog upload it also requires the live manifest version to equal
  the candidate tag.

The release job uses its existing R2-only token. The Pages deploy-hook URL is an
opaque secret URL stored as `RBOX_HOME_DEPLOY_HOOK` in the GitHub `release`
environment. It adds no cross-repository commit or GitHub token.

## API

Extend the existing public release gateway:

- `GET /changelog.md` streams `releases/changelog.md` from the existing
  `rbox_releases` binding;
- response type is `text/markdown; charset=utf-8`;
- cache is `public, max-age=300, stale-while-revalidate=60`;
- the existing release rate limiter remains in front of the cached entrypoint;
- missing content is `404` with `no-store`;
- add `changelog.md` to the bounded telemetry route vocabulary.

No Markdown parsing or Cloudflare REST call runs in the Worker.

## Astro page

Add `/changelog/` to `rbox-home-page` using its existing `LegalLayout` styles.
At build time the page fetches `https://api.rbox.to/changelog.md` with a
cache-busting query and a short timeout. A committed snapshot of the same file
is used for local/offline builds. Cloudflare Pages builds fail on a missing or
invalid CDN response so the previous deployment stays live and the release job
can be retried instead of silently publishing stale notes.

Astro renders the Markdown at build time with a conventional Markdown parser.
It consumes the source `# Changelog` and empty `[Unreleased]` heading so
`LegalLayout` owns the page's single H1. Raw HTML in Markdown is escaped; links
receive safe protocol handling. Released-version headings receive deterministic
anchors/permalinks, and other headings are ordinary document structure. The page
includes Changelog links in the
homepage/shared navigation and footers plus `public/llms.txt`. Astro's existing
sitemap integration discovers the route automatically.

The deploy hook rebuilds the static/no-JavaScript/indexable page after each CLI
release. There is no client-side feed protocol.

## Rollout and validation

1. Add the R2 upload, public Worker route/tests, Astro page, links, and deployment
   documentation.
2. Run core/API tests and typecheck; run the website build and inspect the page.
3. Deploy the API Worker to dev first and verify the route with a seeded object.
4. Merge core after CI is green, seed the current `CHANGELOG.md` to R2, and let
   the automatic production Worker deploy complete.
5. Create the `rbox-home` `main` Pages deploy hook, store it as the core release
   environment secret, merge the website, and verify both public URLs.

## Recovery

While the one-day release artifact exists, rerun the failed publish job. Later,
rerun publication from the exact protected tag. Changelog-only recovery is one
R2 object upload followed by one deploy-hook POST; commands live in
`docs/DEPLOYMENTS.md`.

## Non-goals

- No structured changelog API.
- No GitHub Releases dependency.
- No raw HTML authored separately from `CHANGELOG.md`.
- No browser-side changelog renderer or reconciliation logic.
