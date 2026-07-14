import AppKit
import SwiftUI

struct MenuContentView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            if model.workspaces.isEmpty {
                emptyView
            } else if let workspace = model.selectedWorkspace {
                if model.workspaces.count > 1 {
                    workspaceSwitcher
                    Divider()
                }
                workspacePanel(workspace)
            }
        }
        .frame(width: 296)
        .background(.regularMaterial)
        .alert("rbox Bar", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) {
            Button("OK") { model.errorMessage = nil }
        } message: {
            Text(model.errorMessage ?? "")
        }
    }

    private var emptyView: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("No workspaces")
                    .font(.system(size: 13, weight: .semibold))
                Spacer()
                statePill(.empty)
            }
            Text("No daemon status directories were found.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            Divider()
            footer(nil)
            quitButton
        }
        .padding(14)
    }

    private var workspaceSwitcher: some View {
        Picker("Workspace", selection: $model.selectionID) {
            ForEach(model.workspaces) { workspace in
                Text(workspace.name).tag(Optional(workspace.dirURL))
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private func workspacePanel(_ workspace: WorkspaceStatus) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            header(workspace)

            if workspace.state == .syncing {
                operationBlock(workspace.operation)
            }

            if workspace.attentionReason == .watcherDegraded {
                degradedStatusLine
            } else if workspace.severityTier == .critical {
                attentionBanner(workspace)
            }

            statusSummary(workspace)
            if let deferred = deferredStatusText(workspace) {
                infoRow(label: "Git", value: deferred, monospace: false, color: .secondary)
            }

            Divider()
            pauseResumeButton(for: workspace)
            restartButton(for: workspace)
            itemButton(title: "Open logs", symbol: "line.3.horizontal") {
                model.openLog(for: workspace)
            }
            Divider()
            if let availableVersion = model.availableUpdate(for: workspace) {
                updateButton(availableVersion)
            }
            footer(workspace)
            Divider()
            quitButton
        }
        .padding(14)
    }

    private func header(_ workspace: WorkspaceStatus) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Text(workspace.name)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 8)
                statePill(workspace)
            }
            if let rootPath = workspace.rootPath {
                Text(Self.displayPath(rootPath))
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
    }

    private func statePill(_ workspace: WorkspaceStatus) -> some View {
        let label: String = {
            switch workspace.severityTier {
            case .degraded:
                return "Degraded"
            case .critical:
                return "Attention"
            case .ok:
                break
            }

            switch workspace.state {
            case .synced:
                return "Synced"
            case .syncing:
                return workspace.operation?.kind == .push ? "Pushing" : "Pulling"
            case .attention:
                return "Synced"
            case .paused:
                return "Paused"
            }
        }()

        let color: Color = {
            switch workspace.severityTier {
            case .degraded:
                return .orange
            case .critical:
                return .red
            case .ok:
                break
            }

            switch workspace.state {
            case .synced:
                return .green
            case .syncing:
                return .blue
            case .attention:
                return .green
            case .paused:
                return .gray
            }
        }()

        return HStack(spacing: 5) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
            Text(label)
                .font(.system(size: 11, weight: .medium))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(color.opacity(0.12), in: Capsule())
        .overlay(Capsule().stroke(color.opacity(0.25), lineWidth: 1))
    }

    private func operationBlock(_ operation: SyncOperation?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            infoRow(label: "Status", value: phaseText(operation?.phase), monospace: false, color: .primary)
            infoRow(label: "File", value: truncatedPath(operation?.currentPath), monospace: true, color: .blue)
            infoRow(label: "Progress", value: progressText(operation), monospace: false, color: .primary)
            progressBar(fraction: progressFraction(operation))
        }
        .padding(10)
        .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.primary.opacity(0.08), lineWidth: 1))
    }

    /// The mockup's 4pt blue-gradient progress bar (a custom bar, not `ProgressView`,
    /// so it matches the gradient and renders predictably offscreen).
    private func progressBar(fraction: Double) -> some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.15))
                Capsule()
                    .fill(LinearGradient(
                        colors: [Color(red: 10 / 255, green: 132 / 255, blue: 1),
                                 Color(red: 74 / 255, green: 168 / 255, blue: 1)],
                        startPoint: .leading, endPoint: .trailing))
                    .frame(width: max(0, geo.size.width * fraction))
            }
        }
        .frame(height: 4)
    }

    private func infoRow(label: String, value: String, monospace: Bool, color: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .frame(width: 58, alignment: .leading)
            Text(value)
                .font(monospace ? .system(size: 11, design: .monospaced) : .system(size: 12))
                .foregroundStyle(color)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 0)
        }
    }

    private func attentionBanner(_ workspace: WorkspaceStatus) -> some View {
        return VStack(alignment: .leading, spacing: 4) {
            Text(Self.attentionTitle(workspace.reason))
                .font(.system(size: 12, weight: .semibold))
            if let detail = Self.informativeDetail(
                headline: Self.attentionTitle(workspace.reason),
                detail: Self.attentionDetail(workspace)
            ) {
                Text(detail)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(Self.criticalRemedy(workspace.reason))
                .font(.system(size: 11, weight: .medium))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.red.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.red.opacity(0.32), lineWidth: 1))
    }

    private var degradedStatusLine: some View {
        Text(Self.degradedStatusText)
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func statusSummary(_ workspace: WorkspaceStatus) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(primaryStatusText(workspace))
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.primary)
            if let detail = secondaryStatusText(workspace) {
                Text(detail)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func primaryStatusText(_ workspace: WorkspaceStatus) -> String {
        if let fileCount = workspace.fileCount {
            let count = Self.integerFormatter.string(from: NSNumber(value: fileCount)) ?? "\(fileCount)"
            return "\(count) files · \(stateSummary(workspace))"
        }

        var parts: [String] = []
        if let last = workspace.lastSyncedAt {
            parts.append("Last synced \(relativeTime(last))")
        }
        if let sizeLabel = sizeOrSequenceLabel(workspace) {
            parts.append(sizeLabel)
        }
        return parts.isEmpty ? stateSummary(workspace).capitalized : parts.joined(separator: " · ")
    }

    private func secondaryStatusText(_ workspace: WorkspaceStatus) -> String? {
        guard workspace.fileCount != nil else { return nil }
        var parts: [String] = []
        if let last = workspace.lastSyncedAt {
            parts.append("Last synced \(relativeTime(last))")
        }
        if let sizeLabel = sizeOrSequenceLabel(workspace) {
            parts.append(sizeLabel)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func deferredStatusText(_ workspace: WorkspaceStatus) -> String? {
        guard let count = workspace.deferredRepos, count > 0 else { return nil }
        let noun = count == 1 ? "repo" : "repos"
        if let age = workspace.oldestDeferralAgeSeconds {
            return "\(count) \(noun) deferred · \(Self.deferralAgeBucket(age))"
        }
        return "\(count) \(noun) deferred"
    }

    static func deferralAgeBucket(_ seconds: Int) -> String {
        let age = max(0, seconds)
        if age < 3_600 { return "\(age / 60)m" }
        if age < 86_400 { return "1h" }
        if age < 7 * 86_400 { return "1d" }
        if age < 14 * 86_400 { return "7d" }
        if age < 30 * 86_400 { return "14d" }
        return "30d"
    }

    private func sizeOrSequenceLabel(_ workspace: WorkspaceStatus) -> String? {
        if let totalBytes = workspace.totalBytes {
            return Self.byteCountFormatter.string(fromByteCount: totalBytes)
        }
        if let sequence = workspace.sequence {
            return "seq \(sequence)"
        }
        return nil
    }

    private func stateSummary(_ workspace: WorkspaceStatus) -> String {
        switch workspace.severityTier {
        case .degraded:
            return workspace.attentionReason == .watcherDegraded ? "periodic scans active" : "git deferred"
        case .critical:
            return "not syncing"
        case .ok:
            switch workspace.state {
            case .synced: return "in sync"
            case .syncing: return "syncing"
            case .paused: return "paused"
            case .attention: return "in sync"
            }
        }
    }

    private func pauseResumeButton(for workspace: WorkspaceStatus) -> some View {
        let disabled = workspace.rootPath == nil
        let title: String
        let symbol: String
        if workspace.state == .paused {
            title = disabled ? "Resume unavailable: missing root" : "Resume rbox"
            symbol = "play.fill"
        } else {
            title = disabled ? "Pause unavailable: missing root" : "Pause rbox"
            symbol = "pause.fill"
        }

        return itemButton(title: title, symbol: symbol, disabled: disabled) {
            model.pauseOrResumeSelected()
        }
    }

    private func restartButton(for workspace: WorkspaceStatus) -> some View {
        let disabled = workspace.rootPath == nil
        return itemButton(
            title: disabled ? "Restart unavailable: missing root" : "Restart rbox",
            symbol: "arrow.clockwise",
            disabled: disabled
        ) {
            model.restartSelected()
        }
    }

    private func itemButton(title: String, symbol: String, disabled: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: symbol)
                    .font(.system(size: 12, weight: .semibold))
                    .frame(width: 16)
                Text(title)
                    .font(.system(size: 12))
                    .lineLimit(1)
                Spacer()
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
    }

    private func updateButton(_ availableVersion: String) -> some View {
        Button {
            model.copyInstallCommand()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: model.copiedInstallCommand ? "checkmark" : "arrow.down.circle")
                    .frame(width: 14)
                Text(model.copiedInstallCommand ? "Copied install command" : "Update available: \(availableVersion)")
                    .lineLimit(1)
                Spacer()
            }
            .font(.system(size: 10))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func footer(_ workspace: WorkspaceStatus?) -> some View {
        HStack {
            Text(versionLabel(workspace))
            Spacer()
            Text(shortHostName())
        }
        .font(.system(size: 10))
        .foregroundStyle(.tertiary)
    }

    private var quitButton: some View {
        Button {
            NSApp.terminate(nil)
        } label: {
            HStack {
                Image(systemName: "power")
                    .font(.system(size: 12, weight: .semibold))
                    .frame(width: 16)
                Text("Quit rbox Bar")
                    .font(.system(size: 12))
                Spacer()
                Text("⌘Q")
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 7)
        }
        .buttonStyle(.plain)
        .keyboardShortcut("q", modifiers: .command)
    }

    private func phaseText(_ phase: TransferPhase?) -> String {
        switch phase {
        case .scan:
            return "scanning"
        case .gitcap:
            return "reading git"
        case .encrypt:
            return "encrypting"
        case .upload:
            return "uploading"
        case .download:
            return "downloading"
        case nil:
            return "working"
        }
    }

    private func truncatedPath(_ path: String?) -> String {
        guard let path, !path.isEmpty else { return "—" }
        guard path.count > 42 else { return path }
        let head = path.prefix(19)
        let tail = path.suffix(20)
        return "\(head)...\(tail)"
    }

    private func progressText(_ operation: SyncOperation?) -> String {
        guard let done = operation?.filesDone,
              let total = operation?.filesTotal,
              total > 0 else {
            return "working..."
        }
        let fraction = max(0, min(1, Double(done) / Double(total)))
        let percent = Int((fraction * 100).rounded())
        let doneText = Self.integerFormatter.string(from: NSNumber(value: done)) ?? "\(done)"
        let totalText = Self.integerFormatter.string(from: NSNumber(value: total)) ?? "\(total)"
        return "\(doneText) / \(totalText) - \(percent)%"
    }

    private func progressFraction(_ operation: SyncOperation?) -> Double {
        guard let done = operation?.filesDone,
              let total = operation?.filesTotal,
              total > 0 else {
            return 0
        }
        return max(0, min(1, Double(done) / Double(total)))
    }

    static func attentionTitle(_ reason: String?) -> String {
        switch reason {
        case "quota":
            return "Storage quota needs attention."
        case "watcher":
            return "File watching is degraded."
        case "owner":
            return "Workspace ownership changed."
        case "halt":
            return "Background sync is halted."
        default:
            return "Background sync isn't responding."
        }
    }

    static let degradedStatusText = "File watching degraded — periodic scans keep syncing (~1 min latency)."

    static func attentionDetail(_ workspace: WorkspaceStatus) -> String {
        let ageText: String
        if let age = workspace.heartbeatAgeSeconds {
            ageText = "\(Int(age.rounded())) s ago"
        } else {
            ageText = "unknown"
        }

        switch workspace.reason {
        case "dead", nil:
            return "Last heartbeat \(ageText) - changes are not being synced."
        case "quota":
            return "Storage is full - changes are not being synced."
        case "watcher":
            return "Periodic scans keep syncing (~1 min latency)."
        case "owner":
            return "Workspace ownership changed - changes are not being synced."
        case "halt":
            return "Background sync is halted - changes are not being synced."
        case "error":
            return "Background sync error - changes are not being synced."
        default:
            return "Background sync error - changes are not being synced."
        }
    }

    static func informativeDetail(headline: String, detail: String) -> String? {
        let normalizedHeadline = normalizedComparisonText(headline)
        let normalizedDetail = normalizedComparisonText(detail)
        guard !normalizedDetail.isEmpty else { return nil }
        guard !normalizedHeadline.isEmpty else { return detail }

        if normalizedDetail == normalizedHeadline
            || normalizedDetail.hasPrefix(normalizedHeadline + " ") {
            return nil
        }

        let headlineWords = Set(normalizedHeadline.split(separator: " "))
        let detailWords = Set(normalizedDetail.split(separator: " "))
        let sharedWordCount = headlineWords.intersection(detailWords).count
        let substantiallyRepeatsHeadline = headlineWords.count >= 3
            && sharedWordCount >= 3
            && Double(sharedWordCount) / Double(headlineWords.count) >= 0.75

        return substantiallyRepeatsHeadline ? nil : detail
    }

    private static func normalizedComparisonText(_ text: String) -> String {
        let punctuationStripped = text.lowercased()
            .unicodeScalars
            .map { CharacterSet.alphanumerics.contains($0) ? String($0) : " " }
            .joined()
        return punctuationStripped
            .split(whereSeparator: { $0.isWhitespace })
            .map(String.init)
            .joined(separator: " ")
    }

    static func criticalRemedy(_ reason: String?) -> String {
        switch reason {
        case "quota":
            return "Upgrade storage; rbox retries automatically."
        case "owner":
            return "A newer rbox took over; this one will exit."
        case "halt":
            return "Resolve the logged cause, then restart rbox."
        case "dead", "error", nil:
            return "Restart rbox; open logs if it returns."
        default:
            return "Restart rbox; open logs if it returns."
        }
    }

    private func relativeTime(_ date: Date) -> String {
        let seconds = max(0, Int(Date().timeIntervalSince(date)))
        if seconds < 60 { return "just now" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes) min ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours) hr ago" }
        return "\(hours / 24) d ago"
    }

    private func versionLabel(_ workspace: WorkspaceStatus?) -> String {
        let v = workspace?.daemonVersion ?? model.versionText
        return v.lowercased().hasPrefix("rbox") ? v : "rbox \(v)"
    }

    static func displayPath(_ path: String) -> String {
        let home = NSHomeDirectory()
        if path == home { return "~" }
        if path.hasPrefix(home + "/") {
            return "~" + path.dropFirst(home.count)
        }
        return path
    }

    private func shortHostName() -> String {
        let host = ProcessInfo.processInfo.hostName
        if !host.isEmpty {
            return host.split(separator: ".").first.map(String.init) ?? host
        }
        return Host.current().localizedName ?? "Mac"
    }

    private static let integerFormatter: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        return formatter
    }()

    private static let byteCountFormatter: ByteCountFormatter = {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        formatter.allowsNonnumericFormatting = false
        return formatter
    }()
}
