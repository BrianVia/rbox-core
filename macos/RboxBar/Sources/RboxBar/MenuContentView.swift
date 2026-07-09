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
                statePill(state: .paused, operation: nil)
            }
            Text("No daemon status directories were found.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            Divider()
            footer
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

            if workspace.state == .attention {
                attentionBanner(workspace)
            }

            if workspace.state == .synced || workspace.state == .attention {
                metaLine(workspace)
            }

            Divider()
            actionButton(for: workspace)
            itemButton(title: "Open Dashboard", symbol: "arrow.up.right") {
                model.openDashboard()
            }
            itemButton(title: "View Daemon Log...", symbol: "line.3.horizontal") {
                model.openLog(for: workspace)
            }
            Divider()
            footer
            Divider()
            quitButton
        }
        .padding(14)
    }

    private func header(_ workspace: WorkspaceStatus) -> some View {
        HStack(spacing: 8) {
            Text(workspace.name)
                .font(.system(size: 13, weight: .semibold))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 8)
            statePill(state: workspace.state, operation: workspace.operation)
        }
    }

    private func statePill(state: DaemonState, operation: SyncOperation?) -> some View {
        let label: String = {
            switch state {
            case .synced:
                return "Synced"
            case .syncing:
                return operation?.kind == .push ? "Pushing" : "Pulling"
            case .attention:
                return "Attention"
            case .paused:
                return "Paused"
            }
        }()

        let color: Color = {
            switch state {
            case .synced:
                return .green
            case .syncing:
                return .blue
            case .attention:
                return .red
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
        VStack(alignment: .leading, spacing: 4) {
            Text(Self.attentionTitle(workspace.reason))
                .font(.system(size: 12, weight: .semibold))
            Text(Self.attentionDetail(workspace))
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.red.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.red.opacity(0.32), lineWidth: 1))
    }

    private func metaLine(_ workspace: WorkspaceStatus) -> some View {
        var parts: [String] = []
        if let last = workspace.lastSyncedAt {
            parts.append("Last synced \(relativeTime(last))")
        }
        if let sequence = workspace.sequence {
            parts.append("seq \(sequence)")
        }
        if workspace.state == .synced, let filesTotal = workspace.operation?.filesTotal {
            parts.append("\(Self.integerFormatter.string(from: NSNumber(value: filesTotal)) ?? "\(filesTotal)") files")
        }

        return Text(parts.isEmpty ? "No sync metadata yet" : parts.joined(separator: " · "))
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .lineLimit(2)
    }

    private func actionButton(for workspace: WorkspaceStatus) -> some View {
        let disabled = workspace.rootPath == nil
        let title: String
        let symbol: String
        if workspace.state == .attention {
            title = disabled ? "Restart Unavailable: Missing Root" : "Restart Background Sync"
            symbol = "arrow.clockwise"
        } else if workspace.state == .paused {
            title = disabled ? "Resume Unavailable: Missing Root" : "Resume Background Sync"
            symbol = "play.fill"
        } else {
            title = disabled ? "Pause Unavailable: Missing Root" : "Pause Syncing"
            symbol = "pause.fill"
        }

        return itemButton(title: title, symbol: symbol, disabled: disabled) {
            model.startOrStopSelected()
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

    private var footer: some View {
        HStack {
            Text(versionLabel)
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

    private func relativeTime(_ date: Date) -> String {
        let seconds = max(0, Int(Date().timeIntervalSince(date)))
        if seconds < 60 { return "just now" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes) min ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours) hr ago" }
        return "\(hours / 24) d ago"
    }

    private var versionLabel: String {
        let v = model.versionText
        return v.lowercased().hasPrefix("rbox") ? v : "rbox \(v)"
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
}
