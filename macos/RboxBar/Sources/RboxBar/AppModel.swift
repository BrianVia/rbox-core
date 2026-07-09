import AppKit
import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var workspaces: [WorkspaceStatus] = []
    @Published var selectionID: URL?
    @Published var versionText = "rbox"
    @Published private(set) var latestVersion: String?
    @Published private(set) var copiedInstallCommand = false
    @Published var errorMessage: String?

    private let reader = StatusReader()
    private var timer: Timer?
    private var updateTimer: Timer?
    private var copyFeedbackID = UUID()

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
        startUpdateChecks()
    }

    /// A quiescent model (no polling, no subprocesses) for snapshot rendering/tests.
    init(previewWorkspaces: [WorkspaceStatus], version: String, latestVersion: String? = nil) {
        workspaces = previewWorkspaces
        selectionID = previewWorkspaces.first?.dirURL
        versionText = version
        self.latestVersion = latestVersion
    }

    deinit {
        timer?.invalidate()
        updateTimer?.invalidate()
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

    func pauseOrResumeSelected() {
        guard let workspace = selectedWorkspace else { return }
        guard let root = workspace.rootPath else {
            errorMessage = "This workspace has no root path in daemon.status.json or desired.json."
            return
        }

        let action: RboxActions.SyncAction = workspace.state == .paused ? .start : .stop
        RboxActions.run(action: action, rootPath: root) { [weak self] result in
            Task { @MainActor in self?.handleActionResult(result) }
        }
    }

    func restartSelected() {
        guard let workspace = selectedWorkspace else { return }
        guard let root = workspace.rootPath else {
            errorMessage = "This workspace has no root path in daemon.status.json or desired.json."
            return
        }

        RboxActions.restart(rootPath: root) { [weak self] result in
            Task { @MainActor in self?.handleActionResult(result) }
        }
    }

    func availableUpdate(for workspace: WorkspaceStatus) -> String? {
        let runningVersion = workspace.daemonVersion ?? versionText
        return UpdateCheck.newerVersion(latestVersion, than: runningVersion)
    }

    func copyInstallCommand() {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString("curl -fsSL https://rbox.to/install.sh | sh", forType: .string)
        copiedInstallCommand = true
        let feedbackID = UUID()
        copyFeedbackID = feedbackID
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(1.5))
            guard self?.copyFeedbackID == feedbackID else { return }
            self?.copiedInstallCommand = false
        }
    }

    private func handleActionResult(_ result: Result<Void, Error>) {
        switch result {
        case .success:
            refresh()
        case .failure(let error):
            errorMessage = error.localizedDescription
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

    private func startUpdateChecks() {
        checkForUpdates()
        updateTimer = Timer.scheduledTimer(withTimeInterval: UpdateCheck.interval, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.checkForUpdates()
            }
        }
    }

    private func checkForUpdates() {
        Task { [weak self] in
            guard let version = await UpdateCheck.latestVersion() else { return }
            await MainActor.run {
                self?.latestVersion = version
            }
        }
    }
}
