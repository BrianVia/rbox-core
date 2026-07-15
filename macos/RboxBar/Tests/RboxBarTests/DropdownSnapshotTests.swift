import XCTest
@testable import RboxBar

@MainActor
final class DropdownSemanticTests: XCTestCase {
    private let reference = Date(timeIntervalSince1970: 1_752_580_800)

    private func ws(
        count: Int,
        deferrals: [GitDeferralDetail],
        provenance: DeferralProvenance
    ) -> WorkspaceStatus {
        WorkspaceStatus(
            name: "Development",
            rootPath: "/Users/via/Development",
            dirURL: URL(fileURLWithPath: "/tmp/daemons/Development"),
            logURL: URL(fileURLWithPath: "/tmp/daemons/Development"),
            state: .synced,
            reason: nil,
            operation: nil,
            sequence: 247,
            lastSyncedAt: reference.addingTimeInterval(-120),
            heartbeatAgeSeconds: 2,
            desiredState: "running",
            deferredRepos: count,
            deferrals: deferrals,
            deferralReferenceDate: reference,
            deferralProvenance: provenance
        )
    }

    private func detail(_ repo: String, label: String = "local edits", hours: Double = 2) -> GitDeferralDetail {
        GitDeferralDetail(
            repo: repo,
            reason: "local-edits",
            reasonLabel: label,
            reasonText: "Working files changed here.",
            remediationClass: "transient",
            deferredSince: reference.addingTimeInterval(-hours * 3_600),
            reasonSince: reference.addingTimeInterval(-60),
            checkout: .branch("main")
        )
    }

    func testDeferralRowsExposeSemanticTextFullPathsAndOmittedCount() {
        let details = [
            detail("customer-a/shared/repo", label: "local Git operation"),
            detail("customer-b/shared/repo", label: "git config", hours: 1),
            detail("third/repo-3"),
            detail("fourth/repo-4"),
            detail("fifth/repo-5"),
        ]
        let workspace = ws(count: 7, deferrals: details, provenance: .live)
        let rows = MenuContentView.deferralRowPresentations(workspace, reference: reference)

        XCTAssertEqual(rows.count, 5)
        XCTAssertEqual(rows[0].text, "repo — local Git operation · deferred 1h · reason 1m")
        XCTAssertEqual(rows[1].text, "repo — git config · deferred 1h · reason 1m",
                       "colliding basenames remain distinct through their full-path semantics")
        XCTAssertEqual(rows[0].accessibilityLabel, "customer-a/shared/repo, local Git operation")
        XCTAssertEqual(rows[1].accessibilityLabel, "customer-b/shared/repo, git config")
        XCTAssertEqual(rows[0].helpText, "customer-a/shared/repo")
        XCTAssertEqual(rows[1].helpText, "customer-b/shared/repo")
        XCTAssertEqual(MenuContentView.omittedDeferralRowText(workspace), "+2 more")
    }

    func testDeferralRowsPinFreshnessSuffixes() {
        let item = detail("customer/shared/repo")
        let cases: [(DeferralProvenance, String)] = [
            (.live, ""),
            (.populate, " · initial sync"),
            (.paused, " · as of pause"),
            (.dead, " · stale/display-only"),
        ]
        for (provenance, suffix) in cases {
            let workspace = ws(count: 1, deferrals: [item], provenance: provenance)
            let row = MenuContentView.deferralRowPresentations(workspace, reference: reference)[0]
            XCTAssertTrue(row.text.hasSuffix("reason 1m\(suffix)"), "wrong suffix for \(provenance)")
            XCTAssertNil(MenuContentView.omittedDeferralRowText(workspace))
        }
    }

    func testEveryCriticalStateHasAnHonestRemedy() {
        XCTAssertEqual(MenuContentView.criticalRemedy("halt"),
                       "Resolve the logged cause, then restart rbox.")
        XCTAssertEqual(MenuContentView.criticalRemedy("quota"),
                       "Upgrade storage; rbox retries automatically.")
        XCTAssertEqual(MenuContentView.criticalRemedy("owner"),
                       "A newer rbox took over; this one will exit.")
        XCTAssertEqual(MenuContentView.criticalRemedy("error"),
                       "Restart rbox; open logs if it returns.")
        XCTAssertEqual(MenuContentView.criticalRemedy("dead"),
                       "Restart rbox; open logs if it returns.")
    }

    func testCriticalDetailOnlyRendersWhenItAddsInformation() {
        XCTAssertNil(MenuContentView.informativeDetail(
            headline: "Background sync is halted.",
            detail: "BACKGROUND SYNC IS HALTED — changes are not being synced."
        ))
        XCTAssertNil(MenuContentView.informativeDetail(
            headline: "Background sync is halted.",
            detail: "Sync halted: the background process stopped."
        ))
        XCTAssertEqual(MenuContentView.informativeDetail(
            headline: "Background sync isn't responding.",
            detail: "Last heartbeat 42 s ago - changes are not being synced."
        ), "Last heartbeat 42 s ago - changes are not being synced.")
    }
}
