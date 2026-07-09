import AppKit
import SwiftUI

/// A template-rendered open box with an optional severity dot. The glyph and dot
/// stay as separate layers so macOS can tint the box for any menu-bar appearance
/// without recoloring the amber/red badge.
struct MenuBarLabel: View {
    let workspace: WorkspaceStatus

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Image(nsImage: MenuBarIcon.glyphImage())
                .renderingMode(.template)
                .resizable()
                .interpolation(.high)
                .frame(width: MenuBarIcon.side, height: MenuBarIcon.side)

            if let badgeColor = MenuBarIcon.badgeColor(for: workspace.severityTier) {
                Circle()
                    .fill(.white)
                    .frame(width: MenuBarIcon.badgeDiameter + (2 * MenuBarIcon.badgeGap),
                           height: MenuBarIcon.badgeDiameter + (2 * MenuBarIcon.badgeGap))
                    .blendMode(.destinationOut)

                Circle()
                    .fill(Color(nsColor: badgeColor))
                    .frame(width: MenuBarIcon.badgeDiameter, height: MenuBarIcon.badgeDiameter)
                    .padding(MenuBarIcon.badgeGap)
            }
        }
        .frame(width: MenuBarIcon.side, height: MenuBarIcon.side)
        .compositingGroup()
    }
}

enum MenuBarIcon {
    static let side: CGFloat = 18
    static let badgeDiameter: CGFloat = 5
    static let badgeGap: CGFloat = 1

    static func badgeColor(for tier: SeverityTier) -> NSColor? {
        switch tier {
        case .ok:
            return nil
        case .degraded:
            return .systemOrange
        case .critical:
            return .systemRed
        }
    }

    /// The vector open-box glyph from the bundle. The image is always a template;
    /// severity color belongs exclusively to the separate badge layer above.
    static func glyphImage() -> NSImage {
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
        let image = NSImage(systemSymbolName: "shippingbox", accessibilityDescription: nil) ?? NSImage()
        image.isTemplate = true
        return image
    }
}
