import XCTest
@testable import RboxBar

final class UpdateCheckTests: XCTestCase {
    func testSemanticVersionOrdering() {
        XCTAssertLessThan(SemanticVersion("0.9.16")!, SemanticVersion("0.9.17")!)
        XCTAssertLessThan(SemanticVersion("1.9.9")!, SemanticVersion("2.0.0")!)
        XCTAssertLessThan(SemanticVersion("1.0.0-beta.2")!, SemanticVersion("1.0.0-beta.11")!)
        XCTAssertLessThan(SemanticVersion("1.0.0-beta")!, SemanticVersion("1.0.0")!)
        XCTAssertEqual(SemanticVersion("rbox 0.9.16"), SemanticVersion("v0.9.16+build.1"))
    }

    func testNewerVersionRejectsEqualOlderAndMalformedValues() {
        XCTAssertEqual(UpdateCheck.newerVersion("0.9.17", than: "0.9.16"), "0.9.17")
        XCTAssertNil(UpdateCheck.newerVersion("0.9.16", than: "0.9.16"))
        XCTAssertNil(UpdateCheck.newerVersion("0.9.15", than: "0.9.16"))
        XCTAssertNil(UpdateCheck.newerVersion("latest", than: "0.9.16"))
        XCTAssertNil(UpdateCheck.newerVersion("0.9.17", than: "unknown"))
    }

    func testPollingIntervalIsExactlySixHours() {
        XCTAssertEqual(UpdateCheck.interval, 21_600)
    }
}
