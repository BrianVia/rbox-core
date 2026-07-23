# 191 — Account epoch rotation (forward-secrecy re-key)

Status: STUB — filed 2026-07-23 while ruling design 189 Q1. Not scheduled.

## Why this exists

`rbox device revoke` is ACCESS-ONLY today (apps/api/src/auth/devices.ts:16-21):
it flips `devices.revoked` so the token 401s and the device can mint no new
download grants, but it does NOT re-key. A device that ever held the MK keeps
the ability to decrypt data it already had. The account-epoch data structures
exist (account_key_states, workspace_keys, engine/e2ee/epoch.ts) but NO command
or flow performs an epoch bump — it is designed-but-unbuilt debt from designs
19/22.

## Scope (future)

Build the E -> E+1 rotation: mint a new MK/KEK, re-wrap forward, publish the new
epoch, and have clients adopt it — so a revoked/old-epoch device gets no FUTURE
key material. This backs `device revoke` with real forward secrecy PRODUCT-WIDE,
not just for design 189.

## Relationship to 189

189 (web-approved pairing) ships WITHOUT this per the founder Q1 ruling: revoke
severs future data-plane access, already-exposed plaintext is already exposed,
and a synced device had that plaintext anyway. 191 is the honest long-term
answer for "un-deliver a key," but is NOT on 189's critical path. Onboarding —
189's actual goal — does not need 191.

## Non-goals here

Everything. This is a placeholder so the 189 ruling has a real home to point to.
