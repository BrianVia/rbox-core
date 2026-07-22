# 179A — iCloud Keychain sync feasibility (verified 2026-07-22)

Appendix to design 179 (recovery kit via macOS Keychain). Question from the
founder: can the recovery-phrase Keychain item sync cross-machine via iCloud
Keychain? Verified empirically + against Apple guidance the same night.

## Empirical probe (founder's Mac, macOS 26.5.2, Apple Silicon)

Compiled Swift binary, **ad-hoc signed, no entitlements** (worst-case
approximation of a CLI without a provisioning profile), calling `SecItemAdd`:

| Query | OSStatus | Meaning |
|---|---|---|
| legacy keychain, plain | -25308 | errSecInteractionNotAllowed (SSH session, no UI — works in a GUI session; this is the path `security(1)` uses) |
| data-protection, plain | **-34018** | errSecMissingEntitlement |
| data-protection + synchronizable | **-34018** | errSecMissingEntitlement |
| legacy + synchronizable | **-34018** | synchronizable FORCES the data-protection path — same wall |

Probe source (rerunnable):

```swift
import Security
import Foundation
func attempt(_ label: String, _ extra: [String: Any]) {
    var q: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "rbox-sync-probe-\(label)",
        kSecAttrAccount as String: "probe",
        kSecValueData as String: "probe-secret".data(using: .utf8)!,
    ]
    for (k, v) in extra { q[k] = v }
    print("\(label): SecItemAdd = \(SecItemAdd(q as CFDictionary, nil))")
}
attempt("legacy-plain", [:])
attempt("dp-plain", [kSecUseDataProtectionKeychain as String: true])
attempt("dp-sync", [kSecUseDataProtectionKeychain as String: true, kSecAttrSynchronizable as String: true])
attempt("legacy-sync", [kSecAttrSynchronizable as String: true])
// build: swiftc probe.swift -o probe && ./probe  (ad-hoc linker signing)
```

## Platform rules (Apple guidance)

1. iCloud Keychain sync (`kSecAttrSynchronizable`) exists ONLY in the
   data-protection keychain; `security(1)` drives the legacy file-based
   keychain and can never produce a synced item (TN3137).
2. The data-protection keychain requires restricted entitlements
   (application-identifier / keychain-access-groups) that must be authorized
   by a **provisioning profile**.
3. A **standalone command-line executable cannot embed a provisioning
   profile** — profiles travel in bundles. A command tool needing the
   data-protection keychain must be wrapped in an app-like bundle.
   (Apple Dev Forums; Quinn/DTS standard guidance.)

## Consequence for rbox

- The rbox CLI binary, as shipped (Developer ID, standalone), CANNOT create
  an iCloud-synced Keychain item. This is an Apple platform rule, not a
  design choice. Design 179 therefore ships machine-local
  (`security(1)`-based) and its copy must say "not synced to iCloud
  Keychain".
- **The route to cross-machine sync is a signed .app** — natural candidate:
  the RboxBar menu-bar app (which is ALSO onboarding-backlog item #6's
  original ask: a native macOS app holding the key material). The app
  carries the provisioning profile + entitlements, owns the synchronizable
  item, and the CLI hands it the phrase over a local channel.
- **Remaining unknown for that future spike** (~1h with an app identity in
  hand): confirm that Developer-ID-provisioned apps (as opposed to App
  Store / TestFlight) are granted `kSecAttrSynchronizable` in practice.
  Everything else above is verified.

Founder disposition (2026-07-22): fine — ship 179 machine-local; "we'll get
to a signed binary someday." When that day comes, start here.
