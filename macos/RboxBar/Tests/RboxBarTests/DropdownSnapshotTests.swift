import XCTest
import SwiftUI
@testable import RboxBar

/// Not an assertion test — a visual harness. Renders the dropdown for each design-88
/// state to PNGs under /tmp/rboxbar-snapshots so the panel can be eyeballed against
/// docs/design/assets/88-menubar-mockup.html without driving the live menu bar.
@MainActor
final class DropdownSnapshotTests: XCTestCase {
    private func ws(state: DaemonState, op: SyncOperation? = nil, reason: String? = nil,
                    seq: Int? = 247, lastSyncedAgo: TimeInterval? = 120,
                    hbAge: Double? = nil, name: String = "Development") -> WorkspaceStatus {
        WorkspaceStatus(
            name: name,
            rootPath: "/Users/via/Development",
            dirURL: URL(fileURLWithPath: "/tmp/daemons/\(name)"),
            logURL: URL(fileURLWithPath: "/tmp/daemon.log"),
            state: state, reason: reason, operation: op, sequence: seq,
            lastSyncedAt: lastSyncedAgo.map { Date().addingTimeInterval(-$0) },
            heartbeatAgeSeconds: hbAge, desiredState: state == .paused ? "stopped" : "running"
        )
    }

    private func render(_ model: AppModel, _ name: String, scheme: ColorScheme) {
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
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? png.write(to: dir.appendingPathComponent("\(name).png"))
    }

    func testRenderAllStates() {
        let syncedModel = AppModel(previewWorkspaces: [ws(state: DaemonState.synced)], version: "0.9.11")
        let op = SyncOperation(kind: OperationKind.push, phase: TransferPhase.encrypt,
                           filesDone: 1204, filesTotal: 3412,
                           currentPath: "Personal/rbox-core/src/cli/sync.ts",
                           bytesDone: nil, bytesTotal: nil)
        let syncingModel = AppModel(previewWorkspaces: [ws(state: DaemonState.syncing, op: op)], version: "0.9.11")
        let attentionModel = AppModel(previewWorkspaces: [ws(state: DaemonState.attention, reason: "dead",
            seq: 244, lastSyncedAgo: 10800, hbAge: 42.0)], version: "0.9.11")

        for scheme in [ColorScheme.dark, .light] {
            let suffix = scheme == .dark ? "dark" : "light"
            render(syncedModel, "synced-\(suffix)", scheme: scheme)
            render(syncingModel, "syncing-\(suffix)", scheme: scheme)
            render(attentionModel, "attention-\(suffix)", scheme: scheme)
        }
    }
}
