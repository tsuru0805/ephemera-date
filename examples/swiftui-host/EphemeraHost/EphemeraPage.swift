import SwiftUI

/// The date pages as a SwiftUI view: a full-screen web view plus the host's half of the embedding protocol.
/// scenePhase is forwarded as `lifecycle`.
struct EphemeraPage: View {
    let config: HostConfig
    let route: [String: Any]?
    @EnvironmentObject private var host: HostState
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var holder = ControllerHolder()

    var body: some View {
        EphemeraPageRepresentable(config: config, route: route, holder: holder, host: host)
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .active: holder.controller?.sendLifecycle("active")
                case .background: holder.controller?.sendLifecycle("background")
                default: break        // .inactive (control center, app switcher peek): nothing to tell
                }
            }
    }
}

final class ControllerHolder: ObservableObject {
    weak var controller: EphemeraViewController?
}

private struct EphemeraPageRepresentable: UIViewControllerRepresentable {
    let config: HostConfig
    let route: [String: Any]?
    let holder: ControllerHolder
    let host: HostState

    func makeUIViewController(context: Context) -> EphemeraViewController {
        let vc = EphemeraViewController(config: config, route: route, host: host)
        holder.controller = vc
        host.pendingRoute = nil
        host.navigateOpenPage = { [weak vc] r in vc?.navigate(r) }
        vc.onClose = { [weak host] in
            host?.navigateOpenPage = nil
            host?.pageOpen = false
        }
        return vc
    }

    func updateUIViewController(_ vc: EphemeraViewController, context: Context) {}
}
