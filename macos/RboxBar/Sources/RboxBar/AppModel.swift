import AppKit
import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var workspaces: [WorkspaceStatus] = []
    @Published var selectionID: URL?
    @Published var versionText = "rbox"
    @Published var errorMessage: String?

    private let reader = StatusReader()
    private var timer: Timer?

    var selectedWorkspace: WorkspaceStatus? {
        guard !workspaces.isEmpty else { return nil }
        if let selectionID, let selected = workspaces.first(where: { $0.dirURL == selectionID }) {
            return selected
        }
        return workspaces.first
    }

    var labelWorkspace: WorkspaceStatus {
        if let critical = workspaces.first(where: { $0.severityTier == .critical }) {
            return critical
        }
        if let degraded = workspaces.first(where: { $0.severityTier == .degraded }) {
            return degraded
        }
        if let selected = selectedWorkspace, selected.state == .syncing {
            return selected
        }
        if let syncing = workspaces.first(where: { $0.state == .syncing }) {
            return syncing
        }
        return selectedWorkspace ?? .empty
    }

    init() {
        refresh()
        startPolling()
        loadVersion()
    }

    /// A quiescent model (no polling, no subprocesses) for snapshot rendering/tests.
    init(previewWorkspaces: [WorkspaceStatus], version: String) {
        workspaces = previewWorkspaces
        selectionID = previewWorkspaces.first?.dirURL
        versionText = version
    }

    deinit {
        timer?.invalidate()
    }

    func refresh() {
        Task.detached(priority: .utility) { [reader] in
            let statuses = reader.workspaces()
            await MainActor.run {
                let previous = self.selectionID
                self.workspaces = statuses
                if let previous, statuses.contains(where: { $0.dirURL == previous }) {
                    self.selectionID = previous
                } else {
                    self.selectionID = statuses.first?.dirURL
                }
            }
        }
    }

    func startOrStopSelected() {
        guard let workspace = selectedWorkspace else { return }
        guard let root = workspace.rootPath else {
            errorMessage = "This workspace has no root path in desired.json."
            return
        }

        let action: RboxActions.SyncAction = workspace.state == .paused ? .start : (workspace.state == .attention ? .start : .stop)
        RboxActions.run(action: action, rootPath: root) { [weak self] result in
            Task { @MainActor in
                switch result {
                case .success:
                    self?.refresh()
                case .failure(let error):
                    self?.errorMessage = error.localizedDescription
                }
            }
        }
    }

    func openDashboard() {
        RboxActions.openDashboard()
    }

    func openLog(for workspace: WorkspaceStatus) {
        RboxActions.openLog(workspace.logURL)
    }

    private func startPolling() {
        timer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.refresh()
            }
        }
    }

    private func loadVersion() {
        RboxActions.version { [weak self] version in
            Task { @MainActor in
                self?.versionText = version
            }
        }
    }
}
