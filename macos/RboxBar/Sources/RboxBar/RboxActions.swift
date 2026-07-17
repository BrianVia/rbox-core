import AppKit
import Darwin
import Foundation

enum RboxActionError: LocalizedError {
    case binaryNotFound
    case commandFailed(String)
    case captureFailed(status: Int32, stderr: String)
    case timedOut(RboxCaptureOutput)
    case outputTooLarge
    case invalidUTF8

    var errorDescription: String? {
        switch self {
        case .binaryNotFound:
            return "Unable to find the rbox binary. Set RBOX_BIN or install rbox in a standard location."
        case .commandFailed(let message):
            return message
        case .captureFailed(let status, let stderr):
            return stderr.isEmpty ? "rbox deferral brief failed with exit \(status)." : stderr
        case .timedOut:
            return "rbox did not finish the deferral brief within 10 seconds. Update rbox or run `rbox git deferrals --brief` in Terminal."
        case .outputTooLarge:
            return "rbox returned an unexpectedly large deferral brief. Update rbox and try again."
        case .invalidUTF8:
            return "rbox returned a malformed deferral brief. Update rbox and try again."
        }
    }
}

struct RboxCaptureOutput: Equatable {
    var stdout: String
    var stderr: String
}

enum RboxActions {
    enum SyncAction: String {
        case start
        case stop
    }

    private static let queue = DispatchQueue(label: "to.rbox.RboxBar.actions", qos: .utility)
    private static let captureQueue = DispatchQueue(label: "to.rbox.RboxBar.capture", qos: .utility)
    private static var cachedBinary: String?
    private static var attemptedResolve = false
    private static var cachedVersion: String?

    static func run(action: SyncAction, rootPath: String, completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async {
            guard let binary = resolveBinary() else {
                completion(.failure(RboxActionError.binaryNotFound))
                return
            }

            do {
                try run(binary: binary, arguments: [action.rawValue, rootPath], rootPath: rootPath)
                completion(.success(()))
            } catch {
                completion(.failure(error))
            }
        }
    }

    static func restart(rootPath: String, completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async {
            guard let binary = resolveBinary() else {
                completion(.failure(RboxActionError.binaryNotFound))
                return
            }

            do {
                try run(binary: binary, arguments: [SyncAction.stop.rawValue, rootPath], rootPath: rootPath)
                try run(binary: binary, arguments: [SyncAction.start.rawValue, rootPath], rootPath: rootPath)
                completion(.success(()))
            } catch {
                completion(.failure(error))
            }
        }
    }

    static func upgrade(completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async {
            guard let binary = resolveBinary() else {
                completion(.failure(RboxActionError.binaryNotFound))
                return
            }

            do {
                try run(binary: binary, arguments: ["upgrade"], rootPath: NSHomeDirectory())
                cachedVersion = nil
                completion(.success(()))
            } catch {
                completion(.failure(error))
            }
        }
    }

    static func version(completion: @escaping (String) -> Void) {
        queue.async {
            if let cachedVersion {
                completion(cachedVersion)
                return
            }
            guard let binary = resolveBinary() else {
                cachedVersion = "rbox"
                completion("rbox")
                return
            }

            let process = Process()
            process.executableURL = URL(fileURLWithPath: binary)
            process.arguments = ["--version"]
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = Pipe()

            do {
                try process.run()
                let deadline = Date().addingTimeInterval(1)
                while process.isRunning && Date() < deadline {
                    Thread.sleep(forTimeInterval: 0.02)
                }
                if process.isRunning {
                    process.terminate()
                }
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let output = String(data: data, encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                let value = output?.isEmpty == false ? output! : "rbox"
                cachedVersion = value
                completion(value)
            } catch {
                cachedVersion = "rbox"
                completion("rbox")
            }
        }
    }

    static func openDashboard() {
        NSWorkspace.shared.open(URL(string: "https://app.rbox.to/dashboard")!)
    }

    static func openLog(_ url: URL) {
        NSWorkspace.shared.open(url)
    }

    static func captureDeferralBrief(
        rootPath: String,
        completion: @escaping (Result<RboxCaptureOutput, Error>) -> Void
    ) {
        queue.async {
            guard let binary = resolveBinary() else {
                completion(.failure(RboxActionError.binaryNotFound))
                return
            }
            capture(
                binary: binary,
                arguments: ["git", "deferrals", "--brief"],
                rootPath: rootPath,
                deadline: 10,
                grace: 1,
                stdoutLimit: 1_048_576,
                stderrLimit: 65_536,
                completion: completion
            )
        }
    }

    static func capture(
        binary: String,
        arguments: [String],
        rootPath: String,
        deadline: TimeInterval,
        grace: TimeInterval,
        stdoutLimit: Int,
        stderrLimit: Int,
        completion: @escaping (Result<RboxCaptureOutput, Error>) -> Void
    ) {
        captureQueue.async {
            let result: Result<RboxCaptureOutput, Error>
            do {
                result = .success(try captureNow(
                    binary: binary,
                    arguments: arguments,
                    rootPath: rootPath,
                    deadline: deadline,
                    grace: grace,
                    stdoutLimit: stdoutLimit,
                    stderrLimit: stderrLimit
                ))
            } catch {
                result = .failure(error)
            }
            queue.async { completion(result) }
        }
    }

    private static func captureNow(
        binary: String,
        arguments: [String],
        rootPath: String,
        deadline: TimeInterval,
        grace: TimeInterval,
        stdoutLimit: Int,
        stderrLimit: Int
    ) throws -> RboxCaptureOutput {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = arguments
        process.currentDirectoryURL = URL(fileURLWithPath: rootPath, isDirectory: true)
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        try process.run()

        final class StreamBox: @unchecked Sendable {
            let lock = NSLock()
            var data = Data()
            var overflow = false
            func append(_ chunk: Data, limit: Int) {
                lock.lock()
                defer { lock.unlock() }
                let remaining = max(0, limit - data.count)
                data.append(chunk.prefix(remaining))
                if chunk.count > remaining { overflow = true }
            }

            func snapshot() -> Data {
                lock.lock()
                defer { lock.unlock() }
                return data
            }
        }
        let stdout = StreamBox()
        let stderr = StreamBox()
        let drains = DispatchGroup()
        func drain(_ handle: FileHandle, into box: StreamBox, limit: Int) {
            drains.enter()
            DispatchQueue.global(qos: .utility).async {
                while true {
                    let chunk = handle.availableData
                    if chunk.isEmpty { break }
                    box.append(chunk, limit: limit)
                }
                drains.leave()
            }
        }
        drain(stdoutPipe.fileHandleForReading, into: stdout, limit: stdoutLimit)
        drain(stderrPipe.fileHandleForReading, into: stderr, limit: stderrLimit)

        let expires = Date().addingTimeInterval(deadline)
        while process.isRunning && Date() < expires {
            Thread.sleep(forTimeInterval: 0.01)
        }
        var timedOut = false
        if process.isRunning {
            timedOut = true
            process.terminate()
            let killAt = Date().addingTimeInterval(grace)
            while process.isRunning && Date() < killAt {
                Thread.sleep(forTimeInterval: 0.01)
            }
            if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
        }
        process.waitUntilExit()
        if timedOut {
            // A descendant can inherit these descriptors and keep the read side from
            // reaching EOF after the process we launched has been killed. Give the
            // drains only the remainder of the termination grace period, then close
            // our descriptors so capture completion itself stays deadline-bounded.
            let drainUntil = DispatchTime.now() + max(0, expires.addingTimeInterval(grace).timeIntervalSinceNow)
            if drains.wait(timeout: drainUntil) == .timedOut {
                try? stdoutPipe.fileHandleForReading.close()
                try? stderrPipe.fileHandleForReading.close()
            }
            throw RboxActionError.timedOut(RboxCaptureOutput(
                stdout: String(decoding: stdout.snapshot(), as: UTF8.self),
                stderr: String(decoding: stderr.snapshot(), as: UTF8.self)
            ))
        }
        drains.wait()
        if stdout.overflow || stderr.overflow { throw RboxActionError.outputTooLarge }
        guard let stdoutText = String(data: stdout.data, encoding: .utf8),
              let stderrText = String(data: stderr.data, encoding: .utf8) else {
            throw RboxActionError.invalidUTF8
        }
        guard process.terminationStatus == 0 else {
            let message = stderrText.trimmingCharacters(in: .whitespacesAndNewlines)
            throw RboxActionError.captureFailed(status: process.terminationStatus, stderr: message)
        }
        return RboxCaptureOutput(stdout: stdoutText, stderr: stderrText)
    }

    private static func run(binary: String, arguments: [String], rootPath: String) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = arguments
        process.currentDirectoryURL = URL(fileURLWithPath: rootPath, isDirectory: true)
        let pipe = Pipe()
        process.standardError = pipe
        process.standardOutput = pipe

        try process.run()
        // Drain while the child is running so verbose commands such as `upgrade`
        // cannot fill the pipe buffer and deadlock before termination.
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let message = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let command = arguments.first ?? "command"
            throw RboxActionError.commandFailed(message?.isEmpty == false ? message! : "rbox \(command) failed.")
        }
    }

    private static func resolveBinary() -> String? {
        if attemptedResolve {
            return cachedBinary
        }
        attemptedResolve = true

        let env = ProcessInfo.processInfo.environment
        let candidates = [
            env["RBOX_BIN"],
            // The canonical install.sh location — GUI launches (Raycast/Dock)
            // don't inherit shell PATH, so this must be an explicit candidate.
            "\(NSHomeDirectory())/.rbox/bin/rbox",
            "/opt/homebrew/bin/rbox",
            "/usr/local/bin/rbox",
            "\(NSHomeDirectory())/.bun/bin/rbox",
            "\(NSHomeDirectory())/.local/bin/rbox",
            "/usr/bin/rbox"
        ].compactMap { $0 }

        for candidate in candidates where FileManager.default.isExecutableFile(atPath: candidate) {
            cachedBinary = candidate
            return candidate
        }

        return nil
    }
}
