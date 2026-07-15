import AppKit
import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var workspaces: [WorkspaceStatus] = []
    @Published var selectionID: URL? {
        didSet {
            if oldValue != selectionID { clearCopyPresentation() }
        }
    }
    @Published var versionText = "rbox"
    @Published private(set) var latestVersion: String?
    @Published private(set) var isActionInProgress = false
    @Published private(set) var isUpgradeInProgress = false
    @Published private(set) var isCopyInProgress = false
    @Published private(set) var copyConfirmation: String?
    @Published private(set) var canOfferPartialCopy = false
    @Published var errorMessage: String?

    private let reader = StatusReader()
    private var timer: Timer?
    private var updateTimer: Timer?
    private var hasLoadedWorkspaces = false
    private var hasLoadedVersion = false
    private var copyResetToken = UUID()
    private var copyInvocationGeneration = UUID()
    private var activeCopyGeneration: UUID?
    private var captureBrief: (String, @escaping (Result<RboxCaptureOutput, Error>) -> Void) -> Void = RboxActions.captureDeferralBrief
    private var writePasteboard: (String) -> Bool = { value in
        NSPasteboard.general.clearContents()
        return NSPasteboard.general.setString(value, forType: .string)
    }
    private var schedule: (TimeInterval, @escaping () -> Void) -> Void = { delay, action in
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: action)
    }
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
    init(
        previewWorkspaces: [WorkspaceStatus],
        version: String,
        latestVersion: String? = nil,
        captureBrief: ((String, @escaping (Result<RboxCaptureOutput, Error>) -> Void) -> Void)? = nil,
        writePasteboard: ((String) -> Bool)? = nil,
        schedule: ((TimeInterval, @escaping () -> Void) -> Void)? = nil
    ) {
        workspaces = previewWorkspaces
        selectionID = previewWorkspaces.first?.dirURL
        versionText = version
        self.latestVersion = latestVersion
        if let captureBrief { self.captureBrief = captureBrief }
        if let writePasteboard { self.writePasteboard = writePasteboard }
        if let schedule { self.schedule = schedule }
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
        clearCopyPresentation()
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
        clearCopyPresentation()
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
        clearCopyPresentation()
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
        clearCopyPresentation()
        RboxActions.openDashboard()
    }

    func openLog(for workspace: WorkspaceStatus) {
        clearCopyPresentation()
        RboxActions.openLog(workspace.logURL)
    }

    func copyDeferralBrief() {
        guard activeCopyGeneration == nil else { return }
        clearCopyPresentation()
        guard let workspace = selectedWorkspace else {
            errorMessage = "No workspace is selected."
            return
        }
        guard let root = workspace.rootPath else {
            errorMessage = "This workspace has no root path; run `rbox status` in Terminal."
            return
        }
        let identity = workspace.dirURL
        let generation = UUID()
        copyInvocationGeneration = generation
        activeCopyGeneration = generation
        isCopyInProgress = true
        captureBrief(root) { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                guard self.copyInvocationGeneration == generation,
                      self.activeCopyGeneration == generation,
                      self.selectionID == identity,
                      self.selectedWorkspace?.rootPath == root else { return }
                self.activeCopyGeneration = nil
                self.isCopyInProgress = false
                switch result {
                case .success(let output):
                    guard self.isCompleteBrief(output.stdout) else {
                        self.handleBriefFailure(workspace: workspace, message: "The installed rbox returned a malformed deferral brief. Update rbox and try again.")
                        return
                    }
                    self.copyToPasteboard(output.stdout)
                case .failure(let error):
                    self.handleBriefFailure(workspace: workspace, message: error.localizedDescription)
                }
            }
        }
    }

    func copyPartialDeferralDetails() {
        clearConfirmation()
        guard canOfferPartialCopy, let workspace = selectedWorkspace, workspace.canCopyPartialDeferrals else {
            errorMessage = "Current validated deferral details are unavailable; update rbox or run `rbox status`."
            return
        }
        let reference = workspace.deferralReference()
        var lines = [
            "PARTIAL AND STALE",
            "omitted \(workspace.omittedDeferralCount) repo(s)",
            "contains local repo paths and branch names — share accordingly",
        ]
        for detail in workspace.renderedDeferrals {
            lines.append("")
            lines.append(detail.repo)
            lines.append("\(detail.reasonLabel) — \(detail.reasonText)")
            lines.append("deferred \(Self.deferralAge(detail.deferredSince, reference: reference)) · reason \(Self.deferralAge(detail.reasonSince, reference: reference))")
        }
        copyToPasteboard(lines.joined(separator: "\n") + "\n")
    }

    private func handleBriefFailure(workspace: WorkspaceStatus, message: String) {
        clearConfirmation()
        if workspace.canCopyPartialDeferrals {
            canOfferPartialCopy = true
            errorMessage = "\(message) You can copy partial last-known details instead."
            return
        }
        switch workspace.deferralProvenance {
        case .paused:
            errorMessage = "Deferral details are paused and may be obsolete. Resume rbox or run `rbox status`."
        case .dead:
            errorMessage = "The daemon is not responding; displayed deferral details are stale and cannot be copied. Restart rbox or run `rbox status`."
        case .populate:
            errorMessage = "Initial-sync details could not be attributed to the current workspace. Update rbox or run `rbox status`."
        case .live, nil:
            errorMessage = message
        }
    }

    private func copyToPasteboard(_ value: String) {
        guard writePasteboard(value) else {
            clearCopyPresentation()
            errorMessage = "The clipboard refused the deferral brief. Check clipboard permissions and try again."
            return
        }
        errorMessage = nil
        canOfferPartialCopy = false
        copyConfirmation = "Copied ✓"
        let token = UUID()
        copyResetToken = token
        schedule(2) { [weak self] in
            guard self?.copyResetToken == token else { return }
            self?.copyConfirmation = nil
        }
    }

    private func clearConfirmation() {
        copyResetToken = UUID()
        copyConfirmation = nil
    }

    private func clearCopyPresentation() {
        copyInvocationGeneration = UUID()
        activeCopyGeneration = nil
        clearConfirmation()
        canOfferPartialCopy = false
        isCopyInProgress = false
        errorMessage = nil
    }

    private func isCompleteBrief(_ value: String) -> Bool {
        let content = value.hasSuffix("\n") ? String(value.dropLast()) : value
        let lines = content.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        guard lines.first == "contains local repo paths and branch names — share accordingly",
              lines.contains(where: { $0.hasPrefix("Workspace root: ") && $0.count > "Workspace root: ".count }),
              lines.contains(where: { $0.hasPrefix("rbox version: ") && $0.count > "rbox version: ".count }),
              let rendered = lines.first(where: { $0.hasPrefix("Rendered at: ") }),
              Self.isISODate(String(rendered.dropFirst("Rendered at: ".count))),
              let countLine = lines.first(where: { $0.hasPrefix("Deferred repos: ") }),
              let count = Int(countLine.dropFirst("Deferred repos: ".count)), count >= 0,
              let terminator = lines.last,
              terminator.hasPrefix("-- end of brief · "), terminator.hasSuffix(" repo(s)"),
              let terminatorCount = Int(terminator
                  .dropFirst("-- end of brief · ".count)
                  .dropLast(" repo(s)".count)) else {
            return false
        }
        let sectionCount = lines.filter { $0.hasPrefix("## ") && $0.count > 3 }.count
        return terminatorCount == sectionCount && count == sectionCount
    }

    private static func isISODate(_ value: String) -> Bool {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if fractional.date(from: value) != nil { return true }
        let whole = ISO8601DateFormatter()
        whole.formatOptions = [.withInternetDateTime]
        return whole.date(from: value) != nil
    }

    nonisolated static func deferralAge(_ date: Date, reference: Date) -> String {
        let seconds = reference.timeIntervalSince(date)
        guard seconds >= 0 else { return "unknown" }
        return MenuContentView.deferralAgeBucket(Int(seconds))
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
