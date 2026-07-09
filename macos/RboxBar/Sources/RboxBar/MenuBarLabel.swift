import AppKit
import SwiftUI

/// The menu-bar item: a single composited `NSImage` of the R monogram plus a small
/// state badge (checkmark / up / down / bang / pause). Built as one image — not a
/// SwiftUI ZStack — because `MenuBarExtra` renders any `Text` in the label view
/// (including an `.accessibilityLabel`) as a visible title next to the icon.
///
/// Normal states render as a monochrome **template** so macOS tints them to match a
/// light or dark bar. `attention` renders non-template in red so it actually alarms —
/// the one state whose entire purpose (design 88) is to be noticed.
struct MenuBarLabel: View {
    let workspace: WorkspaceStatus

    var body: some View {
        Image(nsImage: MenuBarIcon.make(for: workspace))
    }
}

enum MenuBarIcon {
    static func make(for workspace: WorkspaceStatus) -> NSImage {
        let attention = workspace.state == .attention
        let size = NSSize(width: 19, height: 16)
        let symbol = badgeSymbol(for: workspace)

        let image = NSImage(size: size, flipped: false) { _ in
            // R monogram (left), sized from the glyph's 376×484 aspect ratio.
            let glyphHeight: CGFloat = 15
            let glyphWidth = glyphHeight * (376.0 / 484.0)
            glyph()?.draw(
                in: NSRect(x: 0, y: (size.height - glyphHeight) / 2, width: glyphWidth, height: glyphHeight),
                from: .zero, operation: .sourceOver, fraction: 1
            )

            // State badge, bottom-trailing.
            if let badge = symbolImage(symbol) {
                let side: CGFloat = 9
                badge.draw(
                    in: NSRect(x: size.width - side, y: 0, width: side, height: side),
                    from: .zero, operation: .sourceOver, fraction: 1
                )
            }

            // Single tint over everything drawn (recolors via source-atop).
            (attention ? NSColor.systemRed : NSColor.black).set()
            NSRect(origin: .zero, size: size).fill(using: .sourceAtop)
            return true
        }
        image.isTemplate = !attention
        return image
    }

    private static func badgeSymbol(for workspace: WorkspaceStatus) -> String {
        switch workspace.state {
        case .synced: return "checkmark"
        case .syncing: return workspace.operation?.kind == .push ? "arrow.up" : "arrow.down"
        case .attention: return "exclamationmark"
        case .paused: return "pause.fill"
        }
    }

    private static func symbolImage(_ name: String) -> NSImage? {
        let config = NSImage.SymbolConfiguration(pointSize: 8, weight: .bold)
        return NSImage(systemSymbolName: name, accessibilityDescription: nil)?
            .withSymbolConfiguration(config)
    }

    /// The vector R glyph from the bundle. Prefers the compiled asset-catalog image,
    /// falls back to the raw template PDF SwiftPM copies in, then an SF Symbol.
    private static func glyph() -> NSImage? {
        if let image = Bundle.module.image(forResource: "RGlyph") {
            image.isTemplate = true
            return image
        }
        if let url = Bundle.module.url(
            forResource: "rbox-glyph", withExtension: "pdf",
            subdirectory: "Assets.xcassets/RGlyph.imageset"
        ), let image = NSImage(contentsOf: url) {
            image.isTemplate = true
            return image
        }
        return NSImage(systemSymbolName: "r.square.fill", accessibilityDescription: nil)
    }
}
