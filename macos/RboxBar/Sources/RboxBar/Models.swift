import Foundation

enum DaemonState: String, Codable, CaseIterable {
    case synced
    case syncing
    case attention
    case paused
}

enum AttentionReason: String, Codable {
    case halt
    case outOfStorage = "out-of-storage"
    case watcherDegraded = "watcher-degraded"
    case ownershipLost = "ownership-lost"
    case unknownError = "unknown-error"
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
    var operation: SyncOperation?
    var sequence: Int?
    var lastSyncedAt: Date?
    var heartbeatAgeSeconds: Double?
    var desiredState: String?
}

extension WorkspaceStatus {
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
            lastSyncedAt: nil,
            heartbeatAgeSeconds: nil,
            desiredState: nil
        )
    }
}
