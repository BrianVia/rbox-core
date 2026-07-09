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
                    hbAge: Double? = nil, name: String = "Development") -> WorkspaceStatus {
        WorkspaceStatus(
            name: name,
            rootPath: "/Users/via/Development",
            dirURL: URL(fileURLWithPath: "/tmp/daemons/\(name)"),
            logURL: URL(fileURLWithPath: "/tmp/daemon.log"),
            state: state, reason: reason, attentionReason: attentionReason,
            operation: op, sequence: seq,
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

        let okModel = AppModel(previewWorkspaces: [ws(state: .synced)], version: "0.9.11")
        let watcherWorkspace = ws(state: DaemonState.attention, reason: "watcher",
            attentionReason: .watcherDegraded, seq: 244, lastSyncedAgo: 120, hbAge: 2.0)
        let degradedModel = AppModel(previewWorkspaces: [watcherWorkspace], version: "0.9.11")
        let criticalWorkspace = ws(state: .attention, reason: "error",
            attentionReason: .unknownError, seq: 244, lastSyncedAgo: 10800, hbAge: 42.0)
        let criticalModel = AppModel(previewWorkspaces: [criticalWorkspace], version: "0.9.11")

        XCTAssertEqual(okModel.labelWorkspace.severityTier, .ok)
        XCTAssertEqual(degradedModel.labelWorkspace.severityTier, .degraded)
        XCTAssertEqual(criticalModel.labelWorkspace.severityTier, .critical)
        XCTAssertEqual(MenuContentView.attentionTitle(watcherWorkspace.reason),
                       "File watching is degraded.")
        XCTAssertEqual(MenuContentView.attentionDetail(watcherWorkspace),
                       "Periodic scans keep syncing (~1 min latency).")

        for scheme in [ColorScheme.dark, .light] {
            let suffix = scheme == .dark ? "dark" : "light"
            try render(okModel, "ok-\(suffix)", scheme: scheme)
            try render(degradedModel, "degraded-\(suffix)", scheme: scheme)
            try render(criticalModel, "critical-\(suffix)", scheme: scheme)
        }
    }
}
