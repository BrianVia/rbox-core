import XCTest
import SwiftUI
@testable import RboxBar

/// Not an assertion test — a visual harness. Renders the dropdown for each design-88
/// state to PNGs under /tmp/rboxbar-snapshots so the panel can be eyeballed against
/// docs/design/assets/88-menubar-mockup.html without driving the live menu bar.
@MainActor
final class DropdownSnapshotTests: XCTestCase {
    private func ws(state: DaemonState, op: SyncOperation? = nil, reason: String? = nil,
                    attentionReason: AmbientAttentionReason? = nil,
                    seq: Int? = 247, lastSyncedAgo: TimeInterval? = 120,
                    hbAge: Double? = nil, name: String = "Development",
                    fileCount: Int? = 128_517, daemonVersion: String? = "0.9.16") -> WorkspaceStatus {
        WorkspaceStatus(
            name: name,
            rootPath: "/Users/via/Development",
            dirURL: URL(fileURLWithPath: "/tmp/daemons/\(name)"),
            logURL: URL(fileURLWithPath: "/tmp/daemon.log"),
            state: state, reason: reason, attentionReason: attentionReason,
            operation: op, sequence: seq, fileCount: fileCount, daemonVersion: daemonVersion,
            lastSyncedAt: lastSyncedAgo.map { Date().addingTimeInterval(-$0) },
            heartbeatAgeSeconds: hbAge, desiredState: state == .paused ? "stopped" : "running"
        )
    }

    private func render(_ model: AppModel, _ name: String, scheme: ColorScheme) throws {
        let view = MenuContentView(model: model)
            .environment(\.colorScheme, scheme)
            .frame(width: 296)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        guard let image = renderer.nsImage,
              let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else {
            XCTFail("render failed for \(name)"); return
        }
        let dir = URL(fileURLWithPath: "/tmp/rboxbar-snapshots")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let output = dir.appendingPathComponent("\(name).png")
        try png.write(to: output, options: .atomic)
        XCTAssertGreaterThan((try output.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? 0, 0)
    }

    func testRenderAllSeverityTiers() throws {
        try? FileManager.default.removeItem(atPath: "/tmp/rboxbar-snapshots")

        let okModel = AppModel(previewWorkspaces: [ws(state: .synced)], version: "0.9.16")
        let watcherWorkspace = ws(state: DaemonState.attention, reason: "watcher",
            attentionReason: .watcherDegraded, seq: 244, lastSyncedAgo: 120, hbAge: 2.0)
        let degradedModel = AppModel(previewWorkspaces: [watcherWorkspace], version: "0.9.16")
        let criticalWorkspace = ws(state: .attention, reason: "halt",
            attentionReason: .halt, seq: 244, lastSyncedAgo: 10800, hbAge: 42.0)
        let criticalModel = AppModel(previewWorkspaces: [criticalWorkspace], version: "0.9.16")
        let updateModel = AppModel(
            previewWorkspaces: [ws(state: .synced)],
            version: "0.9.16",
            latestVersion: "0.9.17"
        )

        XCTAssertEqual(okModel.labelWorkspace.severityTier, .ok)
        XCTAssertEqual(degradedModel.labelWorkspace.severityTier, .degraded)
        XCTAssertEqual(criticalModel.labelWorkspace.severityTier, .critical)
        XCTAssertEqual(MenuContentView.degradedStatusText,
                       "File watching degraded — periodic scans keep syncing (~1 min latency).")
        XCTAssertEqual(MenuContentView.criticalRemedy(criticalWorkspace.reason),
                       "Resolve the logged cause, then restart rbox.")
        XCTAssertNil(MenuContentView.informativeDetail(
            headline: MenuContentView.attentionTitle(criticalWorkspace.reason),
            detail: MenuContentView.attentionDetail(criticalWorkspace)
        ))
        XCTAssertEqual(updateModel.availableUpdate(for: updateModel.selectedWorkspace!), "0.9.17")

        for scheme in [ColorScheme.dark, .light] {
            let suffix = scheme == .dark ? "dark" : "light"
            try render(okModel, "ok-\(suffix)", scheme: scheme)
            try render(degradedModel, "degraded-\(suffix)", scheme: scheme)
            try render(criticalModel, "critical-\(suffix)", scheme: scheme)
            try render(updateModel, "update-available-\(suffix)", scheme: scheme)
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
