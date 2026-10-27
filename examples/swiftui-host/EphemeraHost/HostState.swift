import Foundation
import os
import SwiftUI
import UserNotifications

/// Where the web package is, how it reaches the engine, and the credential to hand over in `init`.
///
/// Sources, first match wins:
///   1. launch environment (`xcrun simctl launch` with SIMCTL_CHILD_EPHEMERA_PAGE_URL etc., or the Xcode scheme)
///   2. what was typed on the host home page (page URL and API base are kept in UserDefaults;
///      the credential only in memory — a real app keeps it in the Keychain)
///   3. defaults: page http://127.0.0.1:18870/app/, API base = the page's origin
struct HostConfig {
    var pageURL: String
    var apiBase: String
    var credential: String

    static let defaultPageURL = "http://127.0.0.1:18870/app/"

    static func load() -> HostConfig {
        let env = ProcessInfo.processInfo.environment
        let d = UserDefaults.standard
        let page = env["EPHEMERA_PAGE_URL"] ?? d.string(forKey: "pageURL") ?? defaultPageURL
        let base = env["EPHEMERA_API_BASE"] ?? d.string(forKey: "apiBase") ?? ""
        let cred = env["EPHEMERA_CREDENTIAL"] ?? ""
        return HostConfig(pageURL: page, apiBase: base, credential: cred)
    }

    func save() {
        UserDefaults.standard.set(pageURL, forKey: "pageURL")
        UserDefaults.standard.set(apiBase, forKey: "apiBase")
    }

    /// Empty API base = the page's own origin (the engine is behind the same server as the page).
    var resolvedAPIBase: String {
        let b = apiBase.trimmingCharacters(in: .whitespaces)
        if !b.isEmpty { return b }
        guard let u = URL(string: pageURL), let scheme = u.scheme, let host = u.host else { return "" }
        return "\(scheme)://\(host)\(u.port.map { ":\($0)" } ?? "")"
    }
}

/// One line in the host's message log (shown on the host home page, also printed to the console).
struct LogLine: Identifiable {
    let id = UUID()
    let time: Date
    let text: String
}

/// The host app's own state: whether the date pages are open, the route to open them at, and a message log.
final class HostState: ObservableObject {
    static let shared = HostState()
    /// Console.app / `log stream --predicate 'subsystem == "ephemera.host"'`
    static let logger = Logger(subsystem: "ephemera.host", category: "bridge")

    @Published var config = HostConfig.load()
    @Published var pageOpen = false
    @Published var log: [LogLine] = []
    /// Route for the next `init` (set when a notification is tapped while the pages are closed).
    var pendingRoute: [String: Any]?
    /// Set while the pages are open: deliver a navigate to the running page.
    var navigateOpenPage: (([String: Any]) -> Void)?

    func record(_ text: String) {
        Self.logger.info("\(text, privacy: .public)")
        log.insert(LogLine(time: Date(), text: text), at: 0)
        if log.count > 200 { log.removeLast(log.count - 200) }
    }

    func open(route: [String: Any]?) {
        if pageOpen, let route, let nav = navigateOpenPage {
            nav(route)
            return
        }
        pendingRoute = route
        pageOpen = true
    }

    func requestNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge]) { granted, _ in
            DispatchQueue.main.async { self.record("notifications \(granted ? "allowed" : "not allowed")") }
        }
    }

    /// `event {kind, planId}` from the page → a local notification. No sound.
    func notify(kind: String, planId: Int?) {
        let content = UNMutableNotificationContent()
        content.title = "Ephemera"
        content.body = Self.eventText[kind] ?? kind
        content.sound = nil
        var info: [String: Any] = ["page": Self.eventPage[kind] ?? "seal"]
        if let planId { info["planId"] = planId }
        content.userInfo = info
        let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }

    // the engine's event kinds → a line for the banner and the page a tap opens
    // (same mapping as the engine's webhook `navigate` targets, ephemera_date/outlet.py)
    static let eventText: [String: String] = [
        "envelope": "A letter arrived",
        "telegram_manual": "A telegram arrived",
        "telegram_auto": "A telegram arrived",
        "cancel": "A date was called off",
        "close": "The date is in the box",
        "late_written": "Something was written for a past date",
    ]
    static let eventPage: [String: String] = [
        "envelope": "seal",
        "telegram_manual": "telegrams", "telegram_auto": "telegrams", "cancel": "telegrams",
        "close": "box", "late_written": "box",
    ]
}
