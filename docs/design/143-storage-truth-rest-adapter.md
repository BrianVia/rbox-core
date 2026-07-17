# 143 — Storage-truth live adapter: bounded REST establishment

Status: implemented and adversarially aligned, 2026-07-17.

## Problem

The design-142 live adapter creates remote D1 and R2 bindings through
`getPlatformProxy()`. In a headless process Wrangler can remain at
`Establishing remote connection...` indefinitely, including when stdout is
piped and `CLOUDFLARE_API_TOKEN` plus `CLOUDFLARE_ACCOUNT_ID` are present. The
operator sees neither a report nor a bounded failure.

## Decision

The operator adapter uses Cloudflare's direct REST APIs for every D1 and R2
read. `apps/api/wrangler.jsonc` remains the checked-in source of the selected
environment's D1 database id, R2 bucket name, and jurisdiction. It is parsed
statically with `unstable_readConfig`; no Wrangler platform proxy or live
Wrangler session is created.

The deployed `/v1/admin/roots-inspect` request is unchanged: it remains a plain
fetch to `RBOX_STORAGE_TRUTH_API`, authenticated by `RBOX_PLATFORM_SECRET`.

## Adapter contract

`RestD1` implements the existing `ReadOnlyD1` prepare/bind/first/all shape.
Every statement is rejected locally unless it is exactly one SELECT statement.
A small lexical scanner tracks single/double/backtick quoted text, bracketed
identifiers, line comments, and block comments so only an optional final
semicolon is accepted outside those regions; appended statements and every
non-`SELECT` statement are rejected before fetch. The
client POSTs `{sql, params}` to
`/client/v4/accounts/{account}/d1/database/{database}/query`, checks the outer
and per-query success envelopes, and rejects any response with nonzero
`meta.rows_written` or `meta.changes`, or `meta.changed_db === true`.

`RestR2` implements the existing `ReadOnlyR2` get/list shape. GET object bytes
and object listings use
`/client/v4/accounts/{account}/r2/buckets/{bucket}/objects[/<encoded-key>]`.
Listing sends `prefix`, `per_page`, and the opaque Cloudflare `cursor`; maps the
`result[]` fields `key`, `size`, and `last_modified`; and maps
`result_info.is_truncated` and `result_info.cursor` without synthesizing a
cursor. A truncated response without a cursor is rejected. GET maps 404 to
`null`, rejects every other non-2xx response, reads the raw body through
`arrayBuffer()`, and validates/maps `Content-Length` and `Last-Modified` to the
contract's `size` and `uploaded`. The configured jurisdiction is forwarded when
present. Object keys are encoded segment-by-segment while `/` remains literal,
as required by the API. Dot-only segments are rejected because WHATWG URL
normalization makes them unsafe in a fetch path (the official Cloudflare client
applies the same rejection).

Both clients receive an injected fetch for deterministic tests. Production uses
`globalThis.fetch` and `Authorization: Bearer $CLOUDFLARE_API_TOKEN`.

## Bounded establishment and failures

`createSource()` validates the selected `RBOX_STORAGE_TRUTH_ENV` (`dev` or
`production`) and required credentials before network work. It concurrently
preflights D1 with `SELECT 1` and R2 with a one-object listing. Each preflight is
bounded by an explicit 20,000 ms deadline implemented by an abort signal plus a
timer race; a fetch that ignores abort still cannot hold the factory open. The
deadline helper clears its timer on every settlement and aborts on timeout. The
pair shares a parent cancellation signal: when either preflight fails, its
sibling is aborted and awaited to settlement before the factory rejects, so no
request or timer is orphaned.

Every establishment failure is a `StorageTruthConnectionError` with structured
fields: `component` (`config`, `d1-rest`, `r2-rest`, or `roots-inspect`), selected `environment`,
`requiredEnvironment`, `timeoutMs` when applicable, and a safe reason that never
includes token contents. The required arrays are exact per component:
`d1-rest`/`r2-rest` name `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`; `roots-inspect` names `RBOX_PLATFORM_SECRET` plus
`RBOX_STORAGE_TRUTH_API` only for dev (production has its checked-in default);
and an invalid environment selection uses `config` and names only
`RBOX_STORAGE_TRUTH_ENV`.

The runner catches source-factory failures, normalizes them into a versioned
`runner-failure` JSON object, writes that object to the requested `--json` path,
renders a concise structured failure to stderr, and exits 2. The JSON preserves
the error's `name`, `component`, `environment`, exact `requiredEnvironment[]`,
optional `timeoutMs`, and safe `reason` fields rather than flattening them into
one message. It never emits only an unhandled rejection/stack trace. Cleanup
remains deterministic if a later preflight fails after another has succeeded;
cleanup errors are also rendered as structured failures and never overwrite an
already-written primary failure.

## Tests and acceptance

Unit tests cover:

1. static production/dev resource resolution without creating temporary proxy
   config;
2. lexical single-SELECT D1 behavior (including quoted/comment semicolons),
   appended-statement rejection, and write-metadata/envelope rejection;
3. R2 REST pagination, including forwarding an injected cursor and mapping the
   next cursor from `result_info` with injected fetch;
4. an establishment promise/fetch that never settles, proving a short injected
   deadline rejects with the named structured timeout error; and
5. runner failure normalization/rendering.

Existing storage-truth adapter and full-run zero-write tests remain green. Gates
are `bun run typecheck`, `bun run test:storage-truth`, and `bun run test:api` when
the sandbox supports the API test runtime.
