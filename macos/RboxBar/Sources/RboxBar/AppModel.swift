import AppKit
import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var workspaces: [WorkspaceStatus] = []
    @Published var selectionID: URL?
    @Published var versionText = "rbox"
    @Published private(set) var latestVersion: String?
    @Published private(set) var isActionInProgress = false
    @Published private(set) var isUpgradeInProgress = false
    @Published var errorMessage: String?

    private let reader = StatusReader()
    private var timer: Timer?
    private var updateTimer: Timer?
    private var hasLoadedWorkspaces = false
    private var hasLoadedVersion = false
    private lazy var updateNotifier = UpdateNotifier(
        runningVersion: { [weak self] in self?.notificationRunningVersion },
        onUpdate: { [weak self] in self?.upgrade() }
    )

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
        // Register the notification delegate during launch so a click that cold-launches
        // the app is delivered. Authorization is still requested only after an update exists.
        _ = updateNotifier
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
                self.hasLoadedWorkspaces = true
                if let previous, statuses.contains(where: { $0.dirURL == previous }) {
                    self.selectionID = previous
                } else {
                    self.selectionID = statuses.first?.dirURL
                }
                self.reconcileUpdateNotification()
            }
        }
    }

    func pauseOrResumeSelected() {
        guard !isActionInProgress else { return }
        guard let workspace = selectedWorkspace else { return }
        guard let root = workspace.rootPath else {
            errorMessage = "This workspace has no root path in daemon.status.json or desired.json."
            return
        }

        isActionInProgress = true
        let action: RboxActions.SyncAction = workspace.state == .paused ? .start : .stop
        RboxActions.run(action: action, rootPath: root) { [weak self] result in
            Task { @MainActor in self?.handleActionResult(result) }
        }
    }

    func restartSelected() {
        guard !isActionInProgress else { return }
        guard let workspace = selectedWorkspace else { return }
        guard let root = workspace.rootPath else {
            errorMessage = "This workspace has no root path in daemon.status.json or desired.json."
            return
        }

        isActionInProgress = true
        RboxActions.restart(rootPath: root) { [weak self] result in
            Task { @MainActor in self?.handleActionResult(result) }
        }
    }

    func availableUpdate(for workspace: WorkspaceStatus) -> String? {
        let runningVersion = workspace.daemonVersion ?? versionText
        return UpdateCheck.newerVersion(latestVersion, than: runningVersion)
    }

    var availableUpdateWithoutWorkspace: String? {
        UpdateCheck.newerVersion(latestVersion, than: versionText)
    }

    func upgrade() {
        guard !isActionInProgress else { return }
        isActionInProgress = true
        isUpgradeInProgress = true
        RboxActions.upgrade { [weak self] result in
            Task { @MainActor in self?.handleUpgradeResult(result) }
        }
    }

    private func handleActionResult(_ result: Result<Void, Error>) {
        isActionInProgress = false
        switch result {
        case .success:
            refresh()
        case .failure(let error):
            errorMessage = error.localizedDescription
        }
    }

    private func handleUpgradeResult(_ result: Result<Void, Error>) {
        isActionInProgress = false
        isUpgradeInProgress = false
        switch result {
        case .success:
            refresh()
            loadVersion()
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
                self?.hasLoadedVersion = true
                self?.reconcileUpdateNotification()
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
                self?.reconcileUpdateNotification()
            }
        }
    }

    private func reconcileUpdateNotification() {
        guard hasLoadedWorkspaces, hasLoadedVersion else { return }
        updateNotifier.evaluate(latestVersion: latestVersion)
    }

    private var notificationRunningVersion: String {
        selectedWorkspace?.daemonVersion ?? versionText
    }
}
