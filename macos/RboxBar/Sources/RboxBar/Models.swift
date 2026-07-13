import Foundation

enum DaemonState: String, Codable, CaseIterable {
    case synced
    case syncing
    case attention
    case paused
}

enum SeverityTier: CaseIterable, Equatable {
    case ok
    case degraded
    case critical
}

enum AmbientAttentionReason: String, Codable, CaseIterable, Hashable {
    case halt
    case outOfStorage = "out-of-storage"
    case watcherDegraded = "watcher-degraded"
    case ownershipLost = "ownership-lost"
    case unknownError = "unknown-error"

    var severityTier: SeverityTier {
        switch self {
        case .watcherDegraded:
            return .degraded
        case .halt, .outOfStorage, .ownershipLost, .unknownError:
            return .critical
        }
    }
}

enum OperationKind: String, Codable {
    case pull
    case push
}

enum TransferPhase: String, Codable {
    case scan
    case gitcap
    case encrypt
    case upload
    case download
}

struct SyncOperation: Codable, Equatable {
    var kind: OperationKind
    var phase: TransferPhase?
    var filesDone: Int?
    var filesTotal: Int?
    var currentPath: String?
    var bytesDone: Int64?
    var bytesTotal: Int64?
}

struct WorkspaceStatus: Identifiable, Equatable {
    var id: URL { dirURL }
    var name: String
    var rootPath: String?
    var dirURL: URL
    var logURL: URL
    var state: DaemonState
    var reason: String?
    var attentionReason: AmbientAttentionReason? = nil
    var operation: SyncOperation?
    var sequence: Int?
    var fileCount: Int? = nil
    var totalBytes: Int64? = nil
    var daemonVersion: String? = nil
    var lastSyncedAt: Date?
    var heartbeatAgeSeconds: Double?
    var desiredState: String?
    var deferredRepos: Int? = nil
    var oldestDeferralAgeSeconds: Int? = nil
}

extension WorkspaceStatus {
    var severityTier: SeverityTier {
        if state == .attention {
            return attentionReason?.severityTier ?? .critical
        }
        return (deferredRepos ?? 0) > 0 ? .degraded : .ok
    }

    static var empty: WorkspaceStatus {
        WorkspaceStatus(
            name: "No workspaces",
            rootPath: nil,
            dirURL: URL(fileURLWithPath: "/"),
            logURL: URL(fileURLWithPath: "/"),
            state: .paused,
            reason: nil,
            operation: nil,
            sequence: nil,
            fileCount: nil,
            totalBytes: nil,
            daemonVersion: nil,
            lastSyncedAt: nil,
            heartbeatAgeSeconds: nil,
            desiredState: nil,
            deferredRepos: nil,
            oldestDeferralAgeSeconds: nil
        )
    }
}
