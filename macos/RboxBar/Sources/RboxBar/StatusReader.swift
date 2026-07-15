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
        let verdict = verdict(for: dir, now: now)
        let rootPath = verdict.workspaceRoot ?? desired?.rootPath
        let name = displayName(rootPath: rootPath, dirName: dir.lastPathComponent)

        return WorkspaceStatus(
            name: name,
            rootPath: rootPath,
            dirURL: dir,
            logURL: dir,
            state: verdict.state,
            reason: verdict.reason,
            attentionReason: verdict.attentionReason,
            operation: verdict.operation,
            sequence: verdict.sequence,
            fileCount: verdict.fileCount,
            totalBytes: verdict.totalBytes,
            daemonVersion: verdict.daemonVersion,
            lastSyncedAt: verdict.lastSyncedAt,
            heartbeatAgeSeconds: verdict.heartbeatAgeSeconds,
            desiredState: desired?.state,
            deferredRepos: verdict.deferredRepos,
            oldestDeferralAgeSeconds: verdict.oldestDeferralAgeSeconds,
            deferrals: verdict.deferrals,
            deferralReferenceDate: verdict.deferralReferenceDate,
            deferralProvenance: verdict.deferralProvenance
        )
    }

    private func verdict(for dir: URL, now: Date) -> Verdict {
        let desired = readDesired(dir.appendingPathComponent("desired.json"))
        let statusURL = dir.appendingPathComponent("daemon.status.json")
        let statusResult = readDaemonStatus(statusURL)
        let populateURL = dir.appendingPathComponent("populate.status.json")
        if let populate = readPopulateStatus(populateURL),
           isFresh(populate.heartbeatAt, now: now),
           isProcessAlive(pid: populate.pid) {
            let ambient: DaemonStatus?
            if case .valid(let status) = statusResult,
               isFresh(status.heartbeatAt, now: now),
               let desired,
               desired.workspaceId == populate.workspaceId,
               status.workspaceRoot == desired.rootPath {
                ambient = status
            } else {
                ambient = nil
            }
            return Verdict(
                state: .syncing,
                reason: nil,
                operation: populate.operation,
                sequence: nil,
                lastSyncedAt: nil,
                heartbeatAgeSeconds: now.timeIntervalSince(populate.heartbeatAt),
                deferredRepos: ambient?.deferredRepos,
                oldestDeferralAgeSeconds: ambient?.oldestDeferralAgeSeconds,
                deferrals: ambient?.deferrals ?? [],
                deferralReferenceDate: ambient == nil ? nil : now,
                deferralProvenance: ambient == nil ? nil : .populate
            )
        }

        let pidPresent = fileManager.fileExists(atPath: dir.appendingPathComponent("daemon.pid").path)

        switch statusResult {
        case .missing:
            return pidPresent ? deadVerdict(age: nil, status: nil) : Verdict(state: .paused)
        case .invalid:
            return deadVerdict(age: nil, status: nil)
        case .valid(let status):
            let age = now.timeIntervalSince(status.heartbeatAt)
            let stale = age < 0 || age > Self.staleInterval
            if !stale {
                return Verdict(
                    state: status.state,
                    reason: status.state == .attention ? mapReason(status.attentionReason) : nil,
                    attentionReason: status.state == .attention ? status.attentionReason : nil,
                    operation: status.operation,
                    sequence: status.sequence,
                    fileCount: status.fileCount,
                    totalBytes: status.totalBytes,
                    daemonVersion: status.daemonVersion,
                    workspaceRoot: status.workspaceRoot,
                    lastSyncedAt: status.lastSyncedAt,
                    heartbeatAgeSeconds: age,
                    deferredRepos: status.deferredRepos,
                    oldestDeferralAgeSeconds: status.oldestDeferralAgeSeconds,
                    deferrals: status.deferrals,
                    deferralReferenceDate: status.state == .paused ? status.heartbeatAt : now,
                    deferralProvenance: status.state == .paused ? .paused : .live
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
                    fileCount: status.fileCount,
                    totalBytes: status.totalBytes,
                    daemonVersion: status.daemonVersion,
                    workspaceRoot: status.workspaceRoot,
                    lastSyncedAt: status.lastSyncedAt,
                    heartbeatAgeSeconds: age,
                    deferredRepos: status.deferredRepos,
                    oldestDeferralAgeSeconds: status.oldestDeferralAgeSeconds,
                    deferrals: status.deferrals,
                    deferralReferenceDate: status.heartbeatAt,
                    deferralProvenance: .paused
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
            fileCount: status?.fileCount,
            totalBytes: status?.totalBytes,
            daemonVersion: status?.daemonVersion,
            workspaceRoot: status?.workspaceRoot,
            lastSyncedAt: status?.lastSyncedAt,
            heartbeatAgeSeconds: age,
            deferredRepos: status?.deferredRepos,
            oldestDeferralAgeSeconds: status?.oldestDeferralAgeSeconds,
            deferrals: status?.deferrals ?? [],
            deferralReferenceDate: status?.heartbeatAt,
            deferralProvenance: status == nil ? nil : .dead
        )
    }

    private func readDesired(_ url: URL) -> DesiredState? {
        guard let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rootPath = object["rootPath"] as? String,
              !rootPath.isEmpty,
              let state = object["state"] as? String,
              let workspaceId = object["workspaceId"] as? String,
              !workspaceId.isEmpty else {
            return nil
        }
        return DesiredState(rootPath: rootPath, state: state, workspaceId: workspaceId)
    }

    private func readPopulateStatus(_ url: URL) -> PopulateStatus? {
        guard let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["schemaVersion"] as? Int == 1,
              object["kind"] as? String == "initial-populate",
              let workspaceId = object["workspaceId"] as? String, !workspaceId.isEmpty,
              // JSONSerialization yields Int/NSNumber, never Int32 — bridge via Int.
              let pidInt = object["pid"] as? Int, pidInt > 0,
              case let pid = Int32(truncatingIfNeeded: pidInt),
              let heartbeatString = object["heartbeatAt"] as? String,
              let heartbeatAt = parseDate(heartbeatString),
              let operationObject = object["operation"] as? [String: Any],
              let operation = parseOperation(operationObject, defaultKind: .pull) else {
            return nil
        }
        return PopulateStatus(workspaceId: workspaceId, pid: pid, heartbeatAt: heartbeatAt, operation: operation)
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
                  isNullOrString(object["lastSyncedAt"]),
                  isOptionalNonnegativeInt(object, key: "deferredRepos", nullable: false),
                  isOptionalNonnegativeInt(object, key: "oldestDeferralAgeSeconds", nullable: true) else {
                return .invalid
            }

            var lastSyncedAt: Date?
            if let lastSyncedString = object["lastSyncedAt"] as? String {
                guard let parsedLastSyncedAt = parseDate(lastSyncedString) else { return .invalid }
                lastSyncedAt = parsedLastSyncedAt
            }

            var operation: SyncOperation?
            if let operationObject = object["operation"] as? [String: Any] {
                operation = parseOperation(operationObject, defaultKind: nil)
            }

            let reason = (object["attentionReason"] as? String).flatMap(AmbientAttentionReason.init(rawValue:))
            let fileCount = (object["fileCount"] as? Int).flatMap { $0 >= 0 ? $0 : nil }
            let totalBytes = int64Value(object["totalBytes"]).flatMap { $0 >= 0 ? $0 : nil }
            let daemonVersion = (object["daemonVersion"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let workspaceRoot = (object["workspaceRoot"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let deferredRepos = (object["deferredRepos"] as? Int).flatMap { $0 >= 0 ? $0 : nil }
            let oldestDeferralAgeSeconds = (object["oldestDeferralAgeSeconds"] as? Int).flatMap { $0 >= 0 ? $0 : nil }
            let deferrals: [GitDeferralDetail]
            if let rawDeferrals = object["deferrals"] {
                let array = rawDeferrals as? [Any] ?? []
                deferrals = array.prefix(5).compactMap(parseDeferral)
            } else {
                deferrals = []
            }
            return .valid(DaemonStatus(
                state: state,
                heartbeatAt: heartbeatAt,
                sequence: object["sequence"] as? Int,
                fileCount: fileCount,
                totalBytes: totalBytes,
                daemonVersion: daemonVersion,
                workspaceRoot: workspaceRoot,
                lastSyncedAt: lastSyncedAt,
                operation: operation,
                attentionReason: reason,
                deferredRepos: deferredRepos,
                oldestDeferralAgeSeconds: oldestDeferralAgeSeconds,
                deferrals: deferrals
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

    private func parseDeferral(_ value: Any) -> GitDeferralDetail? {
        guard let object = value as? [String: Any],
              let rawRepo = object["repo"] as? String,
              let rawReason = object["reason"] as? String,
              let rawLabel = object["reasonLabel"] as? String,
              let rawText = object["reasonText"] as? String,
              let rawClass = object["remediationClass"] as? String,
              let deferredString = object["deferredSince"] as? String,
              let reasonString = object["reasonSince"] as? String,
              let deferredSince = parseDate(deferredString),
              let reasonSince = parseDate(reasonString) else { return nil }

        let repo = boundedText(rawRepo, maximum: 1_024)
        guard !repo.isEmpty else { return nil }
        let reason = boundedText(rawReason, maximum: 128)
        let suppliedLabel = boundedText(rawLabel, maximum: 160)
        let suppliedText = boundedText(rawText, maximum: 512)
        let suppliedRemediation = boundedText(rawClass, maximum: 64)
        let knownReason = Self.knownGitDeferralReasons.contains(reason)
        let label = knownReason ? suppliedLabel : "unrecognized Git issue"
        let text = knownReason ? suppliedText : "Git sync is deferred for an unrecognized reason."
        let remediation = knownReason ? suppliedRemediation : "apply-unavailable"

        var checkout: GitDeferralCheckout?
        if let rawCheckout = object["checkout"] {
            guard let checkoutObject = rawCheckout as? [String: Any],
                  let kind = checkoutObject["kind"] as? String else { return nil }
            if kind == "detached" {
                checkout = .detached
            } else if kind == "branch" {
                if let rawLabel = checkoutObject["label"] {
                    guard let branchLabel = rawLabel as? String else { return nil }
                    checkout = .branch(boundedText(branchLabel, maximum: 512))
                } else {
                    checkout = .branch(nil)
                }
            } else {
                return nil
            }
        }
        return GitDeferralDetail(
            repo: repo,
            reason: reason,
            reasonLabel: label,
            reasonText: text,
            remediationClass: remediation,
            deferredSince: deferredSince,
            reasonSince: reasonSince,
            checkout: checkout
        )
    }

    private func boundedText(_ value: String, maximum: Int) -> String {
        var scalars: [Unicode.Scalar] = []
        var replacingControl = false
        for scalar in value.unicodeScalars {
            let category = scalar.properties.generalCategory
            if scalar == "\r" || scalar == "\n" || category == .control || category == .format {
                if !replacingControl { scalars.append(" ") }
                replacingControl = true
            } else {
                scalars.append(scalar)
                replacingControl = false
            }
        }
        let collapsed = String(String.UnicodeScalarView(scalars))
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
        return String(collapsed.unicodeScalars.prefix(maximum))
    }

    private func parseDate(_ string: String) -> Date? {
        guard string.range(
            of: #"^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$"#,
            options: .regularExpression
        ) != nil else { return nil }
        if let date = ISO8601DateFormatter.rboxWithFractional.date(from: string) {
            return date
        }
        return ISO8601DateFormatter.rbox.date(from: string)
    }

    private static let knownGitDeferralReasons: Set<String> = [
        "local-edits", "local-index", "local-operation", "local-commits", "local-stash",
        "conflict", "git-busy", "worktree-ownership", "ignored-target", "unreadable",
        "artifact", "config", "containment", "unsupported", "other",
    ]

    private func isNullOrInt(_ value: Any?) -> Bool {
        value == nil || value is NSNull || value is Int
    }

    private func isNullOrString(_ value: Any?) -> Bool {
        value == nil || value is NSNull || value is String
    }

    private func isOptionalNonnegativeInt(_ object: [String: Any], key: String, nullable: Bool) -> Bool {
        guard let value = object[key] else { return true }
        if value is NSNull { return nullable }
        guard let int = value as? Int else { return false }
        return int >= 0
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

    private func isFresh(_ date: Date, now: Date) -> Bool {
        let age = now.timeIntervalSince(date)
        return age >= 0 && age <= Self.staleInterval
    }

}

private struct DesiredState {
    var rootPath: String
    var state: String
    var workspaceId: String
}

private struct PopulateStatus {
    var workspaceId: String
    var pid: Int32
    var heartbeatAt: Date
    var operation: SyncOperation
}

private struct DaemonStatus {
    var state: DaemonState
    var heartbeatAt: Date
    var sequence: Int?
    var fileCount: Int?
    var totalBytes: Int64?
    var daemonVersion: String?
    var workspaceRoot: String?
    var lastSyncedAt: Date?
    var operation: SyncOperation?
    var attentionReason: AmbientAttentionReason?
    var deferredRepos: Int?
    var oldestDeferralAgeSeconds: Int?
    var deferrals: [GitDeferralDetail]
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
    var fileCount: Int? = nil
    var totalBytes: Int64? = nil
    var daemonVersion: String? = nil
    var workspaceRoot: String? = nil
    var lastSyncedAt: Date? = nil
    var heartbeatAgeSeconds: Double? = nil
    var deferredRepos: Int? = nil
    var oldestDeferralAgeSeconds: Int? = nil
    var deferrals: [GitDeferralDetail] = []
    var deferralReferenceDate: Date? = nil
    var deferralProvenance: DeferralProvenance? = nil
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
