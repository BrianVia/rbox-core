# Review 219 — spawn-regression red/green evidence

The regression remained unchanged while
`classifyCheckoutOwnership` was temporarily reverted from one
`prove([current, ...stashTips])` call to the legacy call-site shape:

```ts
await Promise.all(tips.map(async (tip) => (await prove([tip]))[0]!));
```

## Red: legacy per-tip shape

```text
$ bun test src/cli/sync-git/follow.test.ts -t 'follow-shaped current plus N stash proofs'
bun test v1.4.0-canary.1 (6c12afd8e)

src/cli/sync-git/follow.test.ts:
327 |   };
328 |   const small = await observe(localTips.slice(0, 2));
329 |   const large = await observe(localTips);
330 |   expect(small.classification.reasons).toEqual(["local-stash", "local-stash"]);
331 |   expect(large.classification.reasons).toEqual(Array.from({ length: localTips.length }, () => "local-stash"));
332 |   expect(large.commands).toHaveLength(small.commands.length);
                               ^
error: expect(received).toHaveLength(expected)

Expected length: 9
Received length: 123

      at <anonymous> (.../src/cli/sync-git/follow.test.ts:332:26)
(fail) issue 569: follow-shaped current plus N stash proofs stay constant-spawn and preserve mapping [323.21ms]

 0 pass
 141 filtered out
 1 fail
 7 expect() calls
Ran 1 test across 1 file. [411.00ms]
```

N=40 distinct stash-like tips plus one current tip and two roots. The legacy
shape scales from 9 spawns at N=2 to 123 at N=40, violating both constant
scaling and the `<=10` bound.

## Green: restored batched shape

```text
$ bun test src/cli/sync-git/follow.test.ts -t 'follow-shaped current plus N stash proofs'
bun test v1.4.0-canary.1 (6c12afd8e)

 1 pass
 141 filtered out
 0 fail
 10 expect() calls
Ran 1 test across 1 file. [349.00ms]
```

The successful large-N trace is exactly `cat-file`, `rev-list`, `rev-list`:
three ownership subprocesses and no `merge-base`.
