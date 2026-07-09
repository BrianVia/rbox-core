import AppKit
import SwiftUI
import XCTest
@testable import RboxBar

@MainActor
final class MenuBarLabelTests: XCTestCase {
    private func workspace(_ attentionReason: AmbientAttentionReason? = nil) -> WorkspaceStatus {
        WorkspaceStatus(
            name: "Development",
            rootPath: "/tmp/Development",
            dirURL: URL(fileURLWithPath: "/tmp/daemon"),
            logURL: URL(fileURLWithPath: "/tmp/daemon.log"),
            state: attentionReason == nil ? .synced : .attention,
            reason: attentionReason == .watcherDegraded ? "watcher" : "error",
            attentionReason: attentionReason,
            operation: nil,
            sequence: nil,
            lastSyncedAt: nil,
            heartbeatAgeSeconds: nil,
            desiredState: "running"
        )
    }

    private func render(_ workspace: WorkspaceStatus) throws -> NSBitmapImageRep {
        let renderer = ImageRenderer(content:
            MenuBarLabel(workspace: workspace)
                .foregroundStyle(Color.black)
                .padding(2)
        )
        renderer.scale = 4
        guard let image = renderer.nsImage,
              let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return bitmap
    }

    func testOkUsesPlainTemplateGlyphWithoutBadge() {
        XCTAssertTrue(MenuBarIcon.glyphImage().isTemplate)
        XCTAssertNil(MenuBarIcon.badgeColor(for: .ok))
        XCTAssertEqual(MenuBarIcon.badgeDiameter, 5)
        XCTAssertEqual(MenuBarIcon.badgeGap, 1)
    }

    func testDegradedAndCriticalUseSemanticBadgeColors() {
        XCTAssertEqual(MenuBarIcon.badgeColor(for: .degraded), .systemOrange)
        XCTAssertEqual(MenuBarIcon.badgeColor(for: .critical), .systemRed)
    }

    func testBadgesRenderInCornerWithoutTintingWholeGlyph() throws {
        let cases: [(AmbientAttentionReason, NSColor)] = [
            (.watcherDegraded, .systemOrange),
            (.unknownError, .systemRed),
        ]

        for (reason, target) in cases {
            let bitmap = try render(workspace(reason))
            var matchingPixels: [(x: Int, y: Int)] = []
            for x in 0..<bitmap.pixelsWide {
                for y in 0..<bitmap.pixelsHigh {
                    guard let color = bitmap.colorAt(x: x, y: y), color.alphaComponent > 0.5 else { continue }
                    if colorDistance(color, target) < 0.18 {
                        matchingPixels.append((x, y))
                    }
                }
            }

            XCTAssertGreaterThan(matchingPixels.count, 20, "missing \(reason) badge")
            XCTAssertGreaterThan(matchingPixels.map(\.x).min() ?? 0, bitmap.pixelsWide / 2,
                                 "severity color escaped the trailing badge")
            let ys = matchingPixels.map(\.y)
            XCTAssertGreaterThan(ys.min() ?? 0, bitmap.pixelsHigh / 2,
                                 "severity color escaped the bottom badge")
        }
    }

    func testBadgeGapKnocksGlyphOutBehindDot() throws {
        let ok = try render(workspace())
        let critical = try render(workspace(.unknownError))
        var knockedOutPixels = 0

        for x in 0..<min(ok.pixelsWide, critical.pixelsWide) {
            for y in 0..<min(ok.pixelsHigh, critical.pixelsHigh) {
                let okAlpha = ok.colorAt(x: x, y: y)?.alphaComponent ?? 0
                let criticalAlpha = critical.colorAt(x: x, y: y)?.alphaComponent ?? 0
                if okAlpha > 0.5 && criticalAlpha < 0.1 {
                    knockedOutPixels += 1
                }
            }
        }

        XCTAssertGreaterThan(knockedOutPixels, 0, "the 1pt badge gap must clear the glyph")
    }

    func testCriticalWorkspaceOutranksDegradedForMenuBarLabel() {
        let degraded = workspace(.watcherDegraded)
        let critical = workspace(.unknownError)
        let model = AppModel(previewWorkspaces: [degraded, critical], version: "test")
        XCTAssertEqual(model.labelWorkspace.severityTier, .critical)
    }

    private func colorDistance(_ lhs: NSColor, _ rhs: NSColor) -> CGFloat {
        guard let lhs = lhs.usingColorSpace(.deviceRGB),
              let rhs = rhs.usingColorSpace(.deviceRGB) else {
            return .greatestFiniteMagnitude
        }
        let dr = lhs.redComponent - rhs.redComponent
        let dg = lhs.greenComponent - rhs.greenComponent
        let db = lhs.blueComponent - rhs.blueComponent
        return sqrt((dr * dr) + (dg * dg) + (db * db))
    }
}
