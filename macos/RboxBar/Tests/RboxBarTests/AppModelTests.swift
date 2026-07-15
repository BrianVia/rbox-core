import Foundation
import XCTest
@testable import RboxBar

@MainActor
final class AppModelTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 2_000_000)

    private var completeBrief: String {
        """
        contains local repo paths and branch names — share accordingly

        Workspace root: /tmp/workspace
        rbox version: 1.0.0
        Rendered at: 2026-07-15T12:00:00.000Z
        Deferred repos: 1

        ## Customer/repo
        diagnosis
        -- end of brief · 1 repo(s)

        """
    }

    private func workspace(
        id: String = "one",
        root: String? = "/tmp/workspace",
        provenance: DeferralProvenance? = .live,
        count: Int = 2
    ) -> WorkspaceStatus {
        let detail = GitDeferralDetail(
            repo: "Customer/repo",
            reason: "config",
            reasonLabel: "git config",
            reasonText: "Common Git configuration could not be synchronized safely.",
            remediationClass: "config",
            deferredSince: now.addingTimeInterval(-3_600),
            reasonSince: now.addingTimeInterval(-60),
            checkout: .branch("ticket/user")
        )
        return WorkspaceStatus(
            name: id,
            rootPath: root,
            dirURL: URL(fileURLWithPath: "/tmp/daemon-\(id)"),
            logURL: URL(fileURLWithPath: "/tmp/daemon-\(id)"),
            state: provenance == .paused ? .paused : .synced,
            reason: nil,
            operation: nil,
            sequence: 1,
            deferredRepos: count,
            deferrals: [detail],
            deferralReferenceDate: now,
            deferralProvenance: provenance
        )
    }

    func testSuccessfulCurrentBriefWritesClipboardAndClearsConfirmation() async {
        var copied: String?
        var scheduled: (() -> Void)?
        let model = AppModel(
            previewWorkspaces: [workspace()],
            version: "1.0",
            captureBrief: { _, completion in
                completion(.success(RboxCaptureOutput(
                    stdout: self.completeBrief,
                    stderr: ""
                )))
            },
            writePasteboard: { copied = $0; return true },
            schedule: { _, action in scheduled = action }
        )
        model.copyDeferralBrief()
        await Task.yield()
        XCTAssertTrue(copied?.contains("## Customer/repo") == true)
        XCTAssertEqual(model.copyConfirmation, "Copied ✓")
        scheduled?()
        XCTAssertNil(model.copyConfirmation)
    }

    func testSelectionChangeCancelsPresentationAndClipboardWrite() async {
        var callback: ((Result<RboxCaptureOutput, Error>) -> Void)?
        var writes = 0
        let first = workspace(id: "one")
        let second = workspace(id: "two")
        let model = AppModel(
            previewWorkspaces: [first, second],
            version: "1.0",
            captureBrief: { _, completion in callback = completion },
            writePasteboard: { _ in writes += 1; return true }
        )
        model.copyDeferralBrief()
        model.selectionID = second.dirURL
        callback?(.success(RboxCaptureOutput(
            stdout: completeBrief,
            stderr: ""
        )))
        await Task.yield()
        XCTAssertEqual(writes, 0)
        XCTAssertNil(model.copyConfirmation)
    }

    func testAtoBtoAStaleCompletionCannotReplaceCurrentCapture() async {
        var callbacks: [(Result<RboxCaptureOutput, Error>) -> Void] = []
        var writes: [String] = []
        let first = workspace(id: "one")
        let second = workspace(id: "two")
        let model = AppModel(
            previewWorkspaces: [first, second],
            version: "1.0",
            captureBrief: { _, completion in callbacks.append(completion) },
            writePasteboard: { writes.append($0); return true }
        )

        model.copyDeferralBrief()
        model.copyDeferralBrief()
        XCTAssertEqual(callbacks.count, 1, "one generation may own at most one capture")

        model.selectionID = second.dirURL
        model.selectionID = first.dirURL
        model.copyDeferralBrief()
        XCTAssertEqual(callbacks.count, 2)
        XCTAssertTrue(model.isCopyInProgress)

        callbacks[0](.success(RboxCaptureOutput(stdout: completeBrief, stderr: "")))
        await Task.yield()
        XCTAssertTrue(model.isCopyInProgress, "the stale A completion must not release the current A generation")
        XCTAssertTrue(writes.isEmpty)

        callbacks[1](.success(RboxCaptureOutput(stdout: completeBrief, stderr: "")))
        await Task.yield()
        XCTAssertFalse(model.isCopyInProgress)
        XCTAssertEqual(writes, [completeBrief])
    }

    func testFailureOffersOnlyEligiblePartialFallbackWithoutCommands() async {
        var copied: String?
        let model = AppModel(
            previewWorkspaces: [workspace(count: 4)],
            version: "1.0",
            captureBrief: { _, completion in completion(.failure(RboxActionError.binaryNotFound)) },
            writePasteboard: { copied = $0; return true }
        )
        model.copyDeferralBrief()
        await Task.yield()
        XCTAssertTrue(model.canOfferPartialCopy)
        model.copyPartialDeferralDetails()
        XCTAssertTrue(copied?.hasPrefix("PARTIAL AND STALE\nomitted 3 repo(s)") == true)
        XCTAssertFalse(copied?.contains("rbox git resolve") == true)
        XCTAssertTrue(copied?.contains("Common Git configuration") == true)
    }

    func testPausedDeadMissingRootAndClipboardRefusalNeverClaimSuccess() async {
        for provenance in [DeferralProvenance.paused, .dead] {
            let model = AppModel(
                previewWorkspaces: [workspace(provenance: provenance)],
                version: "1.0",
                captureBrief: { _, completion in
                    completion(.failure(RboxActionError.timedOut(RboxCaptureOutput(stdout: "", stderr: ""))))
                }
            )
            model.copyDeferralBrief()
            await Task.yield()
            XCTAssertFalse(model.canOfferPartialCopy)
            XCTAssertNil(model.copyConfirmation)
        }

        let missing = AppModel(previewWorkspaces: [workspace(root: nil)], version: "1.0")
        missing.copyDeferralBrief()
        XCTAssertTrue(missing.errorMessage?.contains("no root path") == true)

        let refused = AppModel(
            previewWorkspaces: [workspace()],
            version: "1.0",
            captureBrief: { _, completion in completion(.success(RboxCaptureOutput(
                stdout: self.completeBrief,
                stderr: ""
            ))) },
            writePasteboard: { _ in false }
        )
        refused.copyDeferralBrief()
        await Task.yield()
        XCTAssertNil(refused.copyConfirmation)
        XCTAssertTrue(refused.errorMessage?.contains("clipboard refused") == true)
    }

    func testMalformedSuccessfulOutputUsesPartialFallback() async {
        let model = AppModel(
            previewWorkspaces: [workspace()],
            version: "1.0",
            captureBrief: { _, completion in completion(.success(RboxCaptureOutput(
                stdout: "contains local repo paths and branch names — share accordingly\ntruncated\n",
                stderr: ""
            ))) }
        )
        model.copyDeferralBrief()
        await Task.yield()
        XCTAssertTrue(model.canOfferPartialCopy)
        XCTAssertNil(model.copyConfirmation)
    }

    func testMissingOrMismatchedBriefTerminatorUsesPartialFallback() async {
        let malformed = [
            completeBrief.replacingOccurrences(of: "-- end of brief · 1 repo(s)\n", with: ""),
            completeBrief.replacingOccurrences(of: "-- end of brief · 1 repo(s)", with: "-- end of brief · 2 repo(s)"),
        ]
        for brief in malformed {
            let model = AppModel(
                previewWorkspaces: [workspace()],
                version: "1.0",
                captureBrief: { _, completion in
                    completion(.success(RboxCaptureOutput(stdout: brief, stderr: "")))
                }
            )
            model.copyDeferralBrief()
            await Task.yield()
            XCTAssertTrue(model.canOfferPartialCopy)
            XCTAssertNil(model.copyConfirmation)
        }
    }

    func testTruncatedMultiRepoOutputUsesPartialFallback() async {
        let truncated = completeBrief.replacingOccurrences(of: "Deferred repos: 1", with: "Deferred repos: 2")
        let model = AppModel(
            previewWorkspaces: [workspace()],
            version: "1.0",
            captureBrief: { _, completion in completion(.success(RboxCaptureOutput(stdout: truncated, stderr: ""))) }
        )
        model.copyDeferralBrief()
        await Task.yield()
        XCTAssertTrue(model.canOfferPartialCopy)
        XCTAssertNil(model.copyConfirmation)
    }
}
