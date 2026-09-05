# Fable 5.1 — medium effort — round 2

Invocation explicitly used `--model claude-fable-5-1 --effort medium`. CLI model usage confirms Fable5.1. Input: clarified design288 and summarized executed evidence; no source-code inspection by this reviewer.

ALIGNED.

The round 2 specification resolves the fixture and specification objections from round 1, and the reported executed evidence is consistent with the design.

- **Fixture construction is now explicit.** Native git init for sender and an unrelated receiver, no cloning or sharing of the source Git directory, shared index built then add/remove/modify staged against it, and conflict stages injected with hash-object plus update-index index-info rather than a normal merge.
- **Preconditions precede defect assertions and are distinguishable.** Source shared-index dependency, source-positive stage listing, blob existence at sender, ref and reflog unreachability, and negative cat-file checks in the fresh receiver all run before the product path. The evidence shows every precondition passing before the three intended red results.
- **Expectations come from the source, not the receiver.** Recorded listings with known modes, stages and OIDs define the exact ls-files stage and flag output. Artifact byte equality is correctly scoped to live source before and after observation only.
- **Source immutability is checked concretely.** Live index and referenced shared-index bytes are snapshotted around capture, with checks for no new shared-index file, no leftover lock, and no source refresh.
- **Environment isolation is complete and restored.** Routing, object redirection and split-index test variables are cleared, global config points at /dev/null, system config is disabled, product capture and apply inherit the same context, and teardown restores it without changing the production runner.
- **Scope discipline holds.** Regression only, no product algorithm, no new owner or flag or persistence, normalization explicitly deferred, Bun 1.3.14 results labeled diagnostic rather than release acceptance.

Two non-blocking observations for the implementer, not changes required: the "successful connectivity checks" wording should map to a named command in the evidence, such as git fsck with connectivity-only, since index-only blobs are not reachable from refs. And the receiver shared-index independence check should record how absence is proven, for example that the receiver index carries no link extension, so the intended red result stays tied to the defect rather than to environment.
