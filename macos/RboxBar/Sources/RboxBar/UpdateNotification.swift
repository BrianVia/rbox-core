import Foundation
import UserNotifications

enum UpdateNotificationAuthorizationState {
    case notDetermined
    case authorized
    case denied
}

enum UpdateNotificationDecision: Equatable {
    case none
    case requestAuthorization(version: String)
    case notify(version: String)

    static func make(
        latestVersion: String?,
        runningVersion: String?,
        lastNotifiedVersion: String?,
        authorization: UpdateNotificationAuthorizationState
    ) -> UpdateNotificationDecision {
        guard let latestVersion,
              latestVersion != lastNotifiedVersion,
              let latest = SemanticVersion(latestVersion),
              let running = runningVersion.flatMap(SemanticVersion.init),
              !running.isPrerelease,
              latest > running else {
            return .none
        }

        switch authorization {
        case .notDetermined:
            return .requestAuthorization(version: latestVersion)
        case .authorized:
            return .notify(version: latestVersion)
        case .denied:
            return .none
        }
    }
}

struct UpdateNotificationStore {
    static let lastNotifiedVersionKey = "rbox.lastNotifiedUpdateVersion"

    let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var lastNotifiedVersion: String? {
        get { defaults.string(forKey: Self.lastNotifiedVersionKey) }
        nonmutating set { defaults.set(newValue, forKey: Self.lastNotifiedVersionKey) }
    }
}

final class UpdateNotifier: NSObject, UNUserNotificationCenterDelegate {
    private static let requestIdentifierPrefix = "to.rbox.RboxBar.update."

    private let center: UNUserNotificationCenter
    private let store: UpdateNotificationStore
    private let runningVersion: () -> String?
    private let onUpdate: () -> Void
    private var pendingVersions: Set<String> = []

    init(
        center: UNUserNotificationCenter = .current(),
        store: UpdateNotificationStore = UpdateNotificationStore(),
        runningVersion: @escaping () -> String?,
        onUpdate: @escaping () -> Void
    ) {
        self.center = center
        self.store = store
        self.runningVersion = runningVersion
        self.onUpdate = onUpdate
        super.init()
        center.delegate = self
    }

    func evaluate(latestVersion: String?) {
        let preliminaryDecision = UpdateNotificationDecision.make(
            latestVersion: latestVersion,
            runningVersion: runningVersion(),
            lastNotifiedVersion: store.lastNotifiedVersion,
            authorization: .notDetermined
        )
        guard case .requestAuthorization(let version) = preliminaryDecision,
              !pendingVersions.contains(version) else { return }

        pendingVersions.insert(version)
        center.getNotificationSettings { [weak self] settings in
            DispatchQueue.main.async {
                self?.handle(
                    latestVersion: version,
                    authorization: Self.authorizationState(for: settings.authorizationStatus)
                )
            }
        }
    }

    private func handle(
        latestVersion: String,
        authorization: UpdateNotificationAuthorizationState
    ) {
        let decision = UpdateNotificationDecision.make(
            latestVersion: latestVersion,
            runningVersion: runningVersion(),
            lastNotifiedVersion: store.lastNotifiedVersion,
            authorization: authorization
        )

        switch decision {
        case .none:
            pendingVersions.remove(latestVersion)
        case .requestAuthorization(let version):
            center.requestAuthorization(options: [.alert]) { [weak self] granted, _ in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if granted {
                        self.handle(latestVersion: version, authorization: .authorized)
                    } else {
                        self.pendingVersions.remove(version)
                    }
                }
            }
        case .notify(let version):
            deliver(version: version)
        }
    }

    private func deliver(version: String) {
        let content = UNMutableNotificationContent()
        content.title = "rbox \(version) is available"
        content.body = "Click to update — syncing pauses briefly and resumes."
        content.userInfo = ["version": version]

        let request = UNNotificationRequest(
            identifier: Self.requestIdentifierPrefix + version,
            content: content,
            trigger: nil
        )
        center.add(request) { [weak self] error in
            DispatchQueue.main.async {
                guard let self else { return }
                self.pendingVersions.remove(version)
                if error == nil {
                    self.store.lastNotifiedVersion = version
                }
            }
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
           response.notification.request.identifier.hasPrefix(Self.requestIdentifierPrefix) {
            DispatchQueue.main.async { [onUpdate = self.onUpdate] in onUpdate() }
        }
        completionHandler()
    }

    private static func authorizationState(for status: UNAuthorizationStatus) -> UpdateNotificationAuthorizationState {
        switch status {
        case .notDetermined:
            return .notDetermined
        case .denied:
            return .denied
        case .authorized, .provisional:
            return .authorized
        @unknown default:
            return .denied
        }
    }
}
