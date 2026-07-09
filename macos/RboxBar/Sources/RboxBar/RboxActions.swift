import AppKit
import Foundation

enum RboxActionError: LocalizedError {
    case binaryNotFound
    case commandFailed(String)

    var errorDescription: String? {
        switch self {
        case .binaryNotFound:
            return "Unable to find the rbox binary. Set RBOX_BIN or install rbox in a standard location."
        case .commandFailed(let message):
            return message
        }
    }
}

enum RboxActions {
    enum SyncAction: String {
        case start
        case stop
    }

    private static let queue = DispatchQueue(label: "to.rbox.RboxBar.actions", qos: .utility)
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

    private static func run(binary: String, arguments: [String], rootPath: String) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = arguments
        process.currentDirectoryURL = URL(fileURLWithPath: rootPath, isDirectory: true)
        let pipe = Pipe()
        process.standardError = pipe
        process.standardOutput = pipe

        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
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

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", "command -v rbox"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if let output, !output.isEmpty {
                cachedBinary = output
                return output
            }
        } catch {
            return nil
        }

        return nil
    }
}
