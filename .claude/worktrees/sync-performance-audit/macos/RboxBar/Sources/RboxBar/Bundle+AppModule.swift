import Foundation

extension Bundle {
    /// Resolves resources from the packaged app before falling back to SwiftPM's
    /// generated accessor for development and test builds.
    static var appModule: Bundle {
        if let resourceURL = Bundle.main.resourceURL,
           let bundle = Bundle(
               url: resourceURL.appendingPathComponent("RboxBar_RboxBar.bundle", isDirectory: true)
           ) {
            return bundle
        }

        return .module
    }
}
