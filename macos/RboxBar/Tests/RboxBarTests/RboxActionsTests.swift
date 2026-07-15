import Foundation
import XCTest
@testable import RboxBar

final class RboxActionsTests: XCTestCase {
    private func capture(
        script: String,
        deadline: TimeInterval = 2,
        stdoutLimit: Int = 1_024,
        stderrLimit: Int = 1_024
    ) -> Result<RboxCaptureOutput, Error> {
        let done = expectation(description: "capture completes")
        var result: Result<RboxCaptureOutput, Error>!
        RboxActions.capture(
            binary: "/bin/sh",
            arguments: ["-c", script],
            rootPath: FileManager.default.temporaryDirectory.path,
            deadline: deadline,
            grace: 0.05,
            stdoutLimit: stdoutLimit,
            stderrLimit: stderrLimit
        ) {
            result = $0
            done.fulfill()
        }
        wait(for: [done], timeout: max(5, deadline + 2))
        return result
    }

    func testSeparatesStdoutAndStderr() throws {
        let output = try capture(script: "printf out; printf err >&2").get()
        XCTAssertEqual(output, RboxCaptureOutput(stdout: "out", stderr: "err"))
    }

    func testNonzeroReturnsBoundedStderr() {
        XCTAssertThrowsError(try capture(script: "printf honest-error >&2; exit 7").get()) { error in
            guard case RboxActionError.captureFailed(let status, let stderr) = error else {
                return XCTFail("expected captureFailed, got \(error)")
            }
            XCTAssertEqual(status, 7)
            XCTAssertEqual(stderr, "honest-error")
        }
    }

    func testTimeoutTerminatesThenKillsChildIgnoringTerminate() {
        let started = Date()
        XCTAssertThrowsError(try capture(script: "trap '' TERM; while :; do sleep 1; done", deadline: 0.05).get()) { error in
            guard case RboxActionError.timedOut(_) = error else {
                return XCTFail("expected timeout, got \(error)")
            }
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 2, "kill-and-reap must not leave the capture hung")
    }

    func testTimeoutDoesNotWaitForDescendantHoldingCapturePipesOpen() {
        let started = Date()
        let script = "printf captured-out; printf captured-err >&2; sleep 3 & child=$!; trap '' TERM; while kill -0 $child 2>/dev/null; do sleep 1; done"
        XCTAssertThrowsError(try capture(script: script, deadline: 0.05).get()) { error in
            guard case RboxActionError.timedOut(let output) = error else {
                return XCTFail("expected timeout, got \(error)")
            }
            XCTAssertEqual(output.stdout, "captured-out")
            XCTAssertEqual(output.stderr, "captured-err")
        }
        XCTAssertLessThan(
            Date().timeIntervalSince(started),
            2,
            "an inherited pipe must not extend capture to the descendant's lifetime"
        )
    }

    func testOversizedStreamsFailAfterDraining() {
        XCTAssertThrowsError(try capture(script: "i=0; while [ $i -lt 3000 ]; do printf x; printf y >&2; i=$((i+1)); done", stdoutLimit: 64, stderrLimit: 64).get()) { error in
            guard case RboxActionError.outputTooLarge = error else {
                return XCTFail("expected outputTooLarge, got \(error)")
            }
        }
    }

    func testInvalidUTF8IsRejected() {
        XCTAssertThrowsError(try capture(script: "printf '\\377'").get()) { error in
            guard case RboxActionError.invalidUTF8 = error else {
                return XCTFail("expected invalidUTF8, got \(error)")
            }
        }
    }

    func testCompletionIsDeliveredExactlyOnce() {
        let done = expectation(description: "one completion")
        done.expectedFulfillmentCount = 1
        var calls = 0
        let lock = NSLock()
        RboxActions.capture(
            binary: "/bin/sh",
            arguments: ["-c", "printf ok"],
            rootPath: FileManager.default.temporaryDirectory.path,
            deadline: 1,
            grace: 0.05,
            stdoutLimit: 64,
            stderrLimit: 64
        ) { _ in
            lock.lock()
            calls += 1
            lock.unlock()
            done.fulfill()
        }
        wait(for: [done], timeout: 3)
        Thread.sleep(forTimeInterval: 0.1)
        XCTAssertEqual(calls, 1)
    }
}
