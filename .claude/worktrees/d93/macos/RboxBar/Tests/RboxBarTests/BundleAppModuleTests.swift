import Foundation
import XCTest
@testable import RboxBar

final class BundleAppModuleTests: XCTestCase {
    func testAppModuleResolvesSwiftPMResourceBundleInTestContext() {
        XCTAssertEqual(
            Bundle.appModule.bundleURL.resolvingSymlinksInPath(),
            Bundle.module.bundleURL.resolvingSymlinksInPath()
        )
    }
}
