import XCTest
@testable import RboxBar

final class UpdateNotificationTests: XCTestCase {
    func testNewerReleaseRequestsLazyAuthorizationWhenUndetermined() {
        XCTAssertEqual(
            decision(latest: "1.2.0", running: "1.1.0", authorization: .notDetermined),
            .requestAuthorization(version: "1.2.0")
        )
    }

    func testNewerReleaseNotifiesWhenAuthorized() {
        XCTAssertEqual(
            decision(latest: "1.2.0", running: "1.1.0", authorization: .authorized),
            .notify(version: "1.2.0")
        )
    }

    func testEqualVersionDoesNotNotify() {
        XCTAssertEqual(decision(latest: "1.2.0", running: "1.2.0"), .none)
    }

    func testOlderVersionDoesNotNotify() {
        XCTAssertEqual(decision(latest: "1.1.0", running: "1.2.0"), .none)
    }

    func testAlreadyNotifiedVersionDoesNotNotify() {
        XCTAssertEqual(
            decision(latest: "1.2.0", running: "1.1.0", lastNotified: "1.2.0"),
            .none
        )
    }

    func testPrereleaseRunningVersionDoesNotNotify() {
        XCTAssertEqual(decision(latest: "1.2.0", running: "1.2.0-beta.1"), .none)
    }

    func testDeniedAuthorizationDoesNotNotify() {
        XCTAssertEqual(
            decision(latest: "1.2.0", running: "1.1.0", authorization: .denied),
            .none
        )
    }

    func testLastNotifiedVersionPersistsAtExpectedKey() {
        let suiteName = "UpdateNotificationTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = UpdateNotificationStore(defaults: defaults)

        XCTAssertNil(store.lastNotifiedVersion)
        store.lastNotifiedVersion = "1.2.0"

        XCTAssertEqual(
            defaults.string(forKey: "rbox.lastNotifiedUpdateVersion"),
            "1.2.0"
        )
        XCTAssertEqual(UpdateNotificationStore(defaults: defaults).lastNotifiedVersion, "1.2.0")
    }

    private func decision(
        latest: String?,
        running: String?,
        lastNotified: String? = nil,
        authorization: UpdateNotificationAuthorizationState = .authorized
    ) -> UpdateNotificationDecision {
        UpdateNotificationDecision.make(
            latestVersion: latest,
            runningVersion: running,
            lastNotifiedVersion: lastNotified,
            authorization: authorization
        )
    }
}
