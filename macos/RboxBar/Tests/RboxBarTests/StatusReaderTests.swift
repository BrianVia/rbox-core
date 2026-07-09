import XCTest
@testable import RboxBar

/// Exercises the verdict matrix that mirrors `readPromptStatus` (ambient-status.ts)
/// and `verdict()` (rbox.5s.sh). Each case lays a fake `~/.rbox/daemons/<key>/` down
/// under a temp RBOX_HOME so the real reader runs end-to-end, then asserts the derived
/// state — the load-bearing control flow, not the JSON plumbing the types already cover.
final class StatusReaderTests: XCTestCase {
    private var home: URL!
    private var daemonDir: URL!
    private let reader = StatusReader()

    override func setUpWithError() throws {
        home = FileManager.default.temporaryDirectory
            .appendingPathComponent("rboxbar-test-\(UUID().uuidString)", isDirectory: true)
        daemonDir = home.appendingPathComponent(".rbox/daemons/Workspace-deadbeef", isDirectory: true)
        try FileManager.default.createDirectory(at: daemonDir, withIntermediateDirectories: true)
        setenv("RBOX_HOME", home.path, 1)
    }

    override func tearDownWithError() throws {
        unsetenv("RBOX_HOME")
        try? FileManager.default.removeItem(at: home)
    }

    // MARK: helpers

    private func write(_ name: String, _ json: String) {
        try? json.data(using: .utf8)!.write(to: daemonDir.appendingPathComponent(name))
    }

    private func iso(_ ago: TimeInterval) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Date().addingTimeInterval(-ago))
    }

    private func only() -> WorkspaceStatus {
        let ws = reader.workspaces()
        XCTAssertEqual(ws.count, 1, "expected exactly one discovered workspace")
        return ws[0]
    }

    // MARK: verdict matrix

    func testFreshSynced() {
        write("daemon.pid", "v2 999999 boot")
        write("daemon.status.json", """
        {"schemaVersion":1,"state":"synced","heartbeatAt":"\(iso(2))","sequence":247,"lastSyncedAt":"\(iso(120))"}
        """)
        let ws = only()
        XCTAssertEqual(ws.state, .synced)
        XCTAssertEqual(ws.sequence, 247)
        XCTAssertNotNil(ws.lastSyncedAt)
    }

    func testFreshSyncingPushKeepsOperation() {
        write("daemon.pid", "v2 999999 boot")
        write("daemon.status.json", """
        {"schemaVersion":1,"state":"syncing","heartbeatAt":"\(iso(1))","sequence":9,"lastSyncedAt":null,
         "operation":{"kind":"push","phase":"encrypt","filesDone":1204,"filesTotal":3412,"currentPath":"a/b.ts"}}
        """)
        let ws = only()
        XCTAssertEqual(ws.state, .syncing)
        XCTAssertEqual(ws.operation?.kind, .push)
        XCTAssertEqual(ws.operation?.phase, .encrypt)
        XCTAssertEqual(ws.operation?.filesTotal, 3412)
    }

    func testStaleWithPidfileIsDead() {
        write("daemon.pid", "v2 999999 boot")
        write("daemon.status.json", """
        {"schemaVersion":1,"state":"synced","heartbeatAt":"\(iso(42))","sequence":244,"lastSyncedAt":"\(iso(9000))"}
        """)
        let ws = only()
        XCTAssertEqual(ws.state, .attention)
        XCTAssertEqual(ws.reason, "dead")
        XCTAssertEqual(ws.sequence, 244, "dead verdict should preserve last-known sequence")
    }

    func testAbsentStatusWithPidfileIsDead() {
        write("daemon.pid", "v2 999999 boot")
        let ws = only()
        XCTAssertEqual(ws.state, .attention)
        XCTAssertEqual(ws.reason, "dead")
    }

    func testAbsentStatusNoPidfileIsPaused() {
        let ws = only()
        XCTAssertEqual(ws.state, .paused)
    }

    func testCorruptStatusIsDead() {
        write("daemon.pid", "v2 999999 boot")
        write("daemon.status.json", "{ not json")
        XCTAssertEqual(only().state, .attention)
    }

    func testStalePausedStaysPausedWithoutPidfile() {
        write("daemon.status.json", """
        {"schemaVersion":1,"state":"paused","heartbeatAt":"\(iso(600))","sequence":5,"lastSyncedAt":"\(iso(600))"}
        """)
        let ws = only()
        XCTAssertEqual(ws.state, .paused, "graceful paused with no pidfile stays paused, not dead")
    }

    func testStaleNonPausedNoPidfileIsDead() {
        write("daemon.status.json", """
        {"schemaVersion":1,"state":"syncing","heartbeatAt":"\(iso(600))","sequence":5,"lastSyncedAt":null}
        """)
        XCTAssertEqual(only().state, .attention)
    }

    func testEveryAmbientAttentionReasonMapsToExactlyOneTier() {
        let expectedPromptReasons: [AmbientAttentionReason: String] = [
            .halt: "halt",
            .outOfStorage: "quota",
            .watcherDegraded: "watcher",
            .ownershipLost: "owner",
            .unknownError: "error",
        ]

        XCTAssertEqual(Set(AmbientAttentionReason.allCases), Set(expectedPromptReasons.keys))
        XCTAssertEqual(AmbientAttentionReason.allCases.filter { $0.severityTier == .degraded },
                       [.watcherDegraded], "watcher-degraded is the only degraded reason")
        XCTAssertEqual(AmbientAttentionReason.allCases.filter { $0.severityTier == .critical }.count, 4)

        write("daemon.pid", "v2 999999 boot")
        for reason in AmbientAttentionReason.allCases {
            write("daemon.status.json", """
            {"schemaVersion":1,"state":"attention","heartbeatAt":"\(iso(2))","sequence":1,"lastSyncedAt":null,
             "attentionReason":"\(reason.rawValue)"}
            """)
            let workspace = only()
            XCTAssertEqual(workspace.attentionReason, reason)
            XCTAssertEqual(workspace.reason, expectedPromptReasons[reason])
            XCTAssertEqual(workspace.severityTier, reason.severityTier)
        }
    }

    func testNonAttentionAndSyntheticDeadSeverityTiers() {
        write("daemon.status.json", """
        {"schemaVersion":1,"state":"synced","heartbeatAt":"\(iso(2))","sequence":1,"lastSyncedAt":null}
        """)
        XCTAssertEqual(only().severityTier, .ok)

        write("daemon.pid", "v2 999999 boot")
        write("daemon.status.json", """
        {"schemaVersion":1,"state":"synced","heartbeatAt":"\(iso(42))","sequence":1,"lastSyncedAt":null}
        """)
        XCTAssertEqual(only().severityTier, .critical)
    }

    func testFreshPopulateWithLivePidWins() {
        // A live populate marker overrides an absent daemon.status.json.
        write("populate.status.json", """
        {"schemaVersion":1,"kind":"initial-populate","workspaceId":"w","projectId":"p","stream":"s",
         "pid":\(getpid()),"startedAt":"\(iso(10))","heartbeatAt":"\(iso(1))",
         "operation":{"kind":"pull","phase":"download","filesDone":40,"filesTotal":100}}
        """)
        let ws = only()
        XCTAssertEqual(ws.state, .syncing)
        XCTAssertEqual(ws.operation?.kind, .pull)
        XCTAssertEqual(ws.operation?.filesTotal, 100)
    }

    func testStalePopulateIsIgnored() {
        // Stale heartbeat → fall through to daemon.status.json rules (here: paused).
        write("populate.status.json", """
        {"schemaVersion":1,"kind":"initial-populate","workspaceId":"w","projectId":"p","stream":"s",
         "pid":\(getpid()),"startedAt":"\(iso(600))","heartbeatAt":"\(iso(600))",
         "operation":{"kind":"pull","phase":"download","filesDone":40,"filesTotal":100}}
        """)
        XCTAssertEqual(only().state, .paused, "stale populate must not pin syncing")
    }

    func testDisplayNameFallsBackToDeHashedDir() {
        // No desired.json, no workspace.json → strip the -<8hex> suffix.
        write("daemon.status.json", """
        {"schemaVersion":1,"state":"synced","heartbeatAt":"\(iso(1))","sequence":1,"lastSyncedAt":null}
        """)
        XCTAssertEqual(only().name, "Workspace")
    }

    func testDesiredJsonProvidesRootPath() {
        write("desired.json", """
        {"rootPath":"/tmp/some/Dev","state":"running","accountId":"a","workspaceId":"w","at":"\(iso(1))"}
        """)
        write("daemon.status.json", """
        {"schemaVersion":1,"state":"synced","heartbeatAt":"\(iso(1))","sequence":1,"lastSyncedAt":null}
        """)
        let ws = only()
        XCTAssertEqual(ws.rootPath, "/tmp/some/Dev")
        XCTAssertEqual(ws.name, "Dev", "name derives from rootPath basename when no workspace.json name")
        XCTAssertEqual(ws.desiredState, "running")
    }
}
