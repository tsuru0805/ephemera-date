import SwiftUI
import UserNotifications

@main
struct EphemeraHostApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var host = HostState.shared

    var body: some Scene {
        WindowGroup {
            HostHomeView()
                .environmentObject(host)
        }
    }
}

/// Local notifications for `event` messages: shown as a banner while the app is in front (no sound),
/// and a tap opens the date pages at the event's page.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        if let page = info["page"] as? String {
            var route: [String: Any] = ["page": page]
            if let planId = info["planId"] as? Int { route["planId"] = planId }
            DispatchQueue.main.async { HostState.shared.open(route: route) }
        }
        completionHandler()
    }
}
