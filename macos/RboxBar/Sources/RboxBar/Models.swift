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

enum DeferralProvenance: Equatable {
    case live
    case populate
    case paused
    case dead

    var allowsPartialCopy: Bool { self == .live || self == .populate }
}

enum GitDeferralCheckout: Equatable {
    case branch(String?)
    case detached
}

struct GitDeferralDetail: Equatable, Identifiable {
    var id: String { "\(repo)\u{0}\(deferredSince.timeIntervalSince1970)\u{0}\(reason)" }
    var repo: String
    var reason: String
    var reasonLabel: String
    var reasonText: String
    var remediationClass: String
    var deferredSince: Date
    var reasonSince: Date
    var checkout: GitDeferralCheckout?

    var basename: String {
        URL(fileURLWithPath: repo).lastPathComponent
    }
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
    var deferrals: [GitDeferralDetail] = []
    var deferralReferenceDate: Date? = nil
    var deferralProvenance: DeferralProvenance? = nil

    var renderedDeferrals: [GitDeferralDetail] {
        Array(deferrals.prefix(min(5, max(0, deferredRepos ?? 0))))
    }

    var omittedDeferralCount: Int {
        max(0, (deferredRepos ?? 0) - renderedDeferrals.count)
    }

    var canCopyPartialDeferrals: Bool {
        deferralProvenance?.allowsPartialCopy == true && !renderedDeferrals.isEmpty
    }

    func deferralReference(now: Date = Date()) -> Date {
        switch deferralProvenance {
        case .paused, .dead:
            return deferralReferenceDate ?? now
        case .live, .populate, nil:
            return now
        }
    }
}

extension WorkspaceStatus {
    /// Deferred repos never escalate the headline tier: they render as secondary
    /// detail (Git row + per-repo rows) while the pill/badge track sync activity.
    /// "Degraded"/"Attention" are reserved for attention reasons (halt, storage,
    /// watcher, ownership) — the states where sync is actually impaired.
    var severityTier: SeverityTier {
        if state == .attention {
            return attentionReason?.severityTier ?? .critical
        }
        return .ok
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
