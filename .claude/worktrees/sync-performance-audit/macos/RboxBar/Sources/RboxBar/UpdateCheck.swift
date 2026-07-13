import Foundation

struct SemanticVersion: Comparable, Equatable {
    private let major: Int
    private let minor: Int
    private let patch: Int
    private let prerelease: [String]?

    init?(_ value: String) {
        var normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalized.lowercased().hasPrefix("rbox ") {
            normalized.removeFirst(5)
        }
        if normalized.hasPrefix("v") {
            normalized.removeFirst()
        }
        normalized = normalized.split(separator: "+", maxSplits: 1).first.map(String.init) ?? normalized

        let releaseParts = normalized.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        let core = releaseParts[0].split(separator: ".", omittingEmptySubsequences: false)
        guard core.count == 3,
              let major = Int(core[0]), major >= 0,
              let minor = Int(core[1]), minor >= 0,
              let patch = Int(core[2]), patch >= 0 else {
            return nil
        }

        if releaseParts.count == 2 {
            let identifiers = releaseParts[1].split(separator: ".", omittingEmptySubsequences: false).map(String.init)
            guard !identifiers.isEmpty, identifiers.allSatisfy({ !$0.isEmpty }) else { return nil }
            prerelease = identifiers
        } else {
            prerelease = nil
        }
        self.major = major
        self.minor = minor
        self.patch = patch
    }

    static func < (lhs: SemanticVersion, rhs: SemanticVersion) -> Bool {
        if lhs.major != rhs.major { return lhs.major < rhs.major }
        if lhs.minor != rhs.minor { return lhs.minor < rhs.minor }
        if lhs.patch != rhs.patch { return lhs.patch < rhs.patch }

        switch (lhs.prerelease, rhs.prerelease) {
        case (nil, nil):
            return false
        case (.some, nil):
            return true
        case (nil, .some):
            return false
        case let (.some(left), .some(right)):
            for index in 0..<min(left.count, right.count) where left[index] != right[index] {
                let leftNumber = Int(left[index])
                let rightNumber = Int(right[index])
                switch (leftNumber, rightNumber) {
                case let (.some(a), .some(b)):
                    return a < b
                case (.some, nil):
                    return true
                case (nil, .some):
                    return false
                case (nil, nil):
                    return left[index] < right[index]
                }
            }
            return left.count < right.count
        }
    }
}

enum UpdateCheck {
    static let interval: TimeInterval = 6 * 60 * 60
    static let manifestURL = URL(string: "https://api.rbox.to/version")!

    private struct Manifest: Decodable {
        let version: String
    }

    static func latestVersion() async -> String? {
        do {
            let (data, response) = try await URLSession.shared.data(from: manifestURL)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else { return nil }
            let version = try JSONDecoder().decode(Manifest.self, from: data).version
            return SemanticVersion(version) == nil ? nil : version
        } catch {
            return nil
        }
    }

    static func newerVersion(_ candidate: String?, than current: String?) -> String? {
        guard let candidate,
              let current,
              let candidateVersion = SemanticVersion(candidate),
              let currentVersion = SemanticVersion(current),
              candidateVersion > currentVersion else { return nil }
        return candidate
    }
}
