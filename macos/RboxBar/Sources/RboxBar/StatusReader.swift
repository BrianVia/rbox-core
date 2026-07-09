import Darwin
import Foundation

struct StatusReader {
    static let staleInterval: TimeInterval = 15

    private let fileManager = FileManager.default

    func workspaces(now: Date = Date()) -> [WorkspaceStatus] {
        let daemons = daemonsDir()
        guard let entries = try? fileManager.contentsOfDirectory(
            at: daemons,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }

        return entries.compactMap { dir -> WorkspaceStatus? in
            guard isDirectory(dir) else { return nil }
            return workspaceStatus(for: dir, now: now)
        }
        .sorted { lhs, rhs in
            lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
    }

    func daemonsDir() -> URL {
        let env = ProcessInfo.processInfo.environment
        let home = env["RBOX_HOME"] ?? NSHomeDirectory()
        return URL(fileURLWithPath: home, isDirectory: true)
            .appendingPathComponent(".rbox", isDirectory: true)
            .appendingPathComponent("daemons", isDirectory: true)
    }

    private func workspaceStatus(for dir: URL, now: Date) -> WorkspaceStatus {
        let desired = readDesired(dir.appendingPathComponent("desired.json"))
        let rootPath = desired?.rootPath
        let name = displayName(rootPath: rootPath, dirName: dir.lastPathComponent)
        let verdict = verdict(for: dir, now: now)

        return WorkspaceStatus(
            name: name,
            rootPath: rootPath,
            dirURL: dir,
            logURL: dir.appendingPathComponent("daemon.log"),
            state: verdict.state,
            reason: verdict.reason,
            attentionReason: verdict.attentionReason,
            operation: verdict.operation,
            sequence: verdict.sequence,
            lastSyncedAt: verdict.lastSyncedAt,
            heartbeatAgeSeconds: verdict.heartbeatAgeSeconds,
            desiredState: desired?.state
        )
    }

    private func verdict(for dir: URL, now: Date) -> Verdict {
        let populateURL = dir.appendingPathComponent("populate.status.json")
        if let populate = readPopulateStatus(populateURL),
           now.timeIntervalSince(populate.heartbeatAt) <= Self.staleInterval,
           isProcessAlive(pid: populate.pid) {
            return Verdict(
                state: .syncing,
                reason: nil,
                operation: populate.operation,
                sequence: nil,
                lastSyncedAt: nil,
                heartbeatAgeSeconds: now.timeIntervalSince(populate.heartbeatAt)
            )
        }

        let statusURL = dir.appendingPathComponent("daemon.status.json")
        let pidPresent = fileManager.fileExists(atPath: dir.appendingPathComponent("daemon.pid").path)
        let statusResult = readDaemonStatus(statusURL)

        switch statusResult {
        case .missing:
            return pidPresent ? deadVerdict(age: nil, status: nil) : Verdict(state: .paused)
        case .invalid:
            return deadVerdict(age: nil, status: nil)
        case .valid(let status):
            let age = now.timeIntervalSince(status.heartbeatAt)
            let stale = age > Self.staleInterval
            if !stale {
                return Verdict(
                    state: status.state,
                    reason: status.state == .attention ? mapReason(status.attentionReason) : nil,
                    attentionReason: status.state == .attention ? status.attentionReason : nil,
                    operation: status.operation,
                    sequence: status.sequence,
                    lastSyncedAt: status.lastSyncedAt,
                    heartbeatAgeSeconds: age
                )
            }

            if pidPresent {
                return deadVerdict(age: age, status: status)
            }

            if status.state == .paused {
                return Verdict(
                    state: .paused,
                    reason: nil,
                    operation: status.operation,
                    sequence: status.sequence,
                    lastSyncedAt: status.lastSyncedAt,
                    heartbeatAgeSeconds: age
                )
            }

            return deadVerdict(age: age, status: status)
        }
    }

    private func deadVerdict(age: TimeInterval?, status: DaemonStatus?) -> Verdict {
        Verdict(
            state: .attention,
            reason: "dead",
            operation: status?.operation,
            sequence: status?.sequence,
            lastSyncedAt: status?.lastSyncedAt,
            heartbeatAgeSeconds: age
        )
    }

    private func readDesired(_ url: URL) -> DesiredState? {
        guard let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rootPath = object["rootPath"] as? String,
              !rootPath.isEmpty,
              let state = object["state"] as? String else {
            return nil
        }
        return DesiredState(rootPath: rootPath, state: state)
    }

    private func readPopulateStatus(_ url: URL) -> PopulateStatus? {
        guard let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["schemaVersion"] as? Int == 1,
              object["kind"] as? String == "initial-populate",
              // JSONSerialization yields Int/NSNumber, never Int32 — bridge via Int.
              let pidInt = object["pid"] as? Int, pidInt > 0,
              case let pid = Int32(truncatingIfNeeded: pidInt),
              let heartbeatString = object["heartbeatAt"] as? String,
              let heartbeatAt = parseDate(heartbeatString),
              let operationObject = object["operation"] as? [String: Any],
              let operation = parseOperation(operationObject, defaultKind: .pull) else {
            return nil
        }
        return PopulateStatus(pid: pid, heartbeatAt: heartbeatAt, operation: operation)
    }

    private func readDaemonStatus(_ url: URL) -> DaemonStatusResult {
        do {
            let data = try Data(contentsOf: url)
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  object["schemaVersion"] as? Int == 1,
                  let stateString = object["state"] as? String,
                  let state = DaemonState(rawValue: stateString),
                  let heartbeatString = object["heartbeatAt"] as? String,
                  let heartbeatAt = parseDate(heartbeatString),
                  isNullOrInt(object["sequence"]),
                  isNullOrString(object["lastSyncedAt"]) else {
                return .invalid
            }

            var lastSyncedAt: Date?
            if let lastSyncedString = object["lastSyncedAt"] as? String {
                lastSyncedAt = parseDate(lastSyncedString)
            }

            var operation: SyncOperation?
            if let operationObject = object["operation"] as? [String: Any] {
                operation = parseOperation(operationObject, defaultKind: nil)
            }

            let reason = (object["attentionReason"] as? String).flatMap(AmbientAttentionReason.init(rawValue:))
            return .valid(DaemonStatus(
                state: state,
                heartbeatAt: heartbeatAt,
                sequence: object["sequence"] as? Int,
                lastSyncedAt: lastSyncedAt,
                operation: operation,
                attentionReason: reason
            ))
        } catch CocoaError.fileReadNoSuchFile {
            return .missing
        } catch {
            if (error as NSError).domain == NSCocoaErrorDomain,
               (error as NSError).code == NSFileReadNoSuchFileError {
                return .missing
            }
            return .invalid
        }
    }

    private func parseOperation(_ object: [String: Any], defaultKind: OperationKind?) -> SyncOperation? {
        let kind: OperationKind
        if let kindString = object["kind"] as? String, let parsed = OperationKind(rawValue: kindString) {
            kind = parsed
        } else if let defaultKind {
            kind = defaultKind
        } else {
            return nil
        }

        let phase = (object["phase"] as? String).flatMap(TransferPhase.init(rawValue:))
        return SyncOperation(
            kind: kind,
            phase: phase,
            filesDone: object["filesDone"] as? Int,
            filesTotal: object["filesTotal"] as? Int,
            currentPath: object["currentPath"] as? String,
            bytesDone: int64Value(object["bytesDone"]),
            bytesTotal: int64Value(object["bytesTotal"])
        )
    }

    private func parseDate(_ string: String) -> Date? {
        if let date = ISO8601DateFormatter.rboxWithFractional.date(from: string) {
            return date
        }
        return ISO8601DateFormatter.rbox.date(from: string)
    }

    private func isNullOrInt(_ value: Any?) -> Bool {
        value == nil || value is NSNull || value is Int
    }

    private func isNullOrString(_ value: Any?) -> Bool {
        value == nil || value is NSNull || value is String
    }

    private func int64Value(_ value: Any?) -> Int64? {
        if let int = value as? Int { return Int64(int) }
        if let number = value as? NSNumber { return number.int64Value }
        return nil
    }

    private func mapReason(_ reason: AmbientAttentionReason?) -> String {
        switch reason {
        case .halt:
            return "halt"
        case .outOfStorage:
            return "quota"
        case .watcherDegraded:
            return "watcher"
        case .ownershipLost:
            return "owner"
        case .unknownError, nil:
            return "error"
        }
    }

    private func displayName(rootPath: String?, dirName: String) -> String {
        if let rootPath {
            let workspaceJSON = URL(fileURLWithPath: rootPath, isDirectory: true)
                .appendingPathComponent(".rbox", isDirectory: true)
                .appendingPathComponent("workspace.json")
            if let data = try? Data(contentsOf: workspaceJSON),
               let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let name = object["name"] as? String,
               !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return name
            }
            return URL(fileURLWithPath: rootPath).lastPathComponent
        }

        return dirName.replacingOccurrences(
            of: #"-[0-9a-fA-F]{8}$"#,
            with: "",
            options: .regularExpression
        )
    }

    private func isDirectory(_ url: URL) -> Bool {
        (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
    }

    private func isProcessAlive(pid: Int32) -> Bool {
        guard pid > 0 else { return false }
        if kill(pid, 0) == 0 {
            return true
        }
        return errno == EPERM
    }
}

private struct DesiredState {
    var rootPath: String
    var state: String
}

private struct PopulateStatus {
    var pid: Int32
    var heartbeatAt: Date
    var operation: SyncOperation
}

private struct DaemonStatus {
    var state: DaemonState
    var heartbeatAt: Date
    var sequence: Int?
    var lastSyncedAt: Date?
    var operation: SyncOperation?
    var attentionReason: AmbientAttentionReason?
}

private enum DaemonStatusResult {
    case missing
    case invalid
    case valid(DaemonStatus)
}

private struct Verdict {
    var state: DaemonState
    var reason: String? = nil
    var attentionReason: AmbientAttentionReason? = nil
    var operation: SyncOperation? = nil
    var sequence: Int? = nil
    var lastSyncedAt: Date? = nil
    var heartbeatAgeSeconds: Double? = nil
}

private extension ISO8601DateFormatter {
    static let rbox: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static let rboxWithFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
