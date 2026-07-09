import AppKit
import SwiftUI

/// Forces menu-bar-agent (no Dock icon) mode. `Info.plist`'s `LSUIElement` already
/// does this for the bundled `.app`; setting the policy here also covers running the
/// bare executable and guarantees it regardless of launch path. It must NOT run in
/// `App.init()` — `NSApp` is still nil that early and force-unwraps to a crash.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
    }
}

@main
struct RboxBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        MenuBarExtra {
            MenuContentView(model: model)
        } label: {
            MenuBarLabel(workspace: model.labelWorkspace)
        }
        .menuBarExtraStyle(.window)
        .commands {
            CommandGroup(replacing: .appTermination) {
                Button("Quit rbox Bar") {
                    NSApp.terminate(nil)
                }
                .keyboardShortcut("q", modifiers: .command)
            }
        }
    }
}
