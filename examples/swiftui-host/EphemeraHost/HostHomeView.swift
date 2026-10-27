import SwiftUI

/// The host app's own first page. The date pages are one feature inside it: the button opens them full screen,
/// and they come back here when the page sends `close`.
struct HostHomeView: View {
    @EnvironmentObject private var host: HostState
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        host.config.save()
                        host.open(route: nil)
                    } label: {
                        Label("Open the date pages", systemImage: "envelope")
                    }
                    .accessibilityIdentifier("open-date")
                    .disabled(host.config.credential.isEmpty)
                    Button {
                        host.config.save()
                        host.open(route: ["page": "shelf"])
                    } label: {
                        Label("Open at the box shelf (init.route)", systemImage: "archivebox")
                    }
                    .accessibilityIdentifier("open-shelf")
                    .disabled(host.config.credential.isEmpty)
                } footer: {
                    if host.config.credential.isEmpty {
                        Text("Enter the credential below first.")
                    }
                }

                Section("Engine") {
                    LabeledContent("Page") {
                        TextField(HostConfig.defaultPageURL, text: $host.config.pageURL)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .keyboardType(.URL).multilineTextAlignment(.trailing)
                    }
                    LabeledContent("API base") {
                        TextField("same origin as the page", text: $host.config.apiBase)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .keyboardType(.URL).multilineTextAlignment(.trailing)
                    }
                    LabeledContent("Credential") {
                        SecureField("EPHEMERA_HER_TOKEN", text: $host.config.credential)
                            .multilineTextAlignment(.trailing)
                            .accessibilityIdentifier("credential")
                    }
                }

                Section("Messages") {
                    if host.log.isEmpty {
                        Text("Nothing yet").foregroundStyle(.secondary)
                    }
                    ForEach(host.log.prefix(40)) { line in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(line.time, format: .dateTime.hour().minute().second())
                                .font(.caption2).foregroundStyle(.secondary)
                            Text(line.text).font(.caption.monospaced()).lineLimit(4)
                        }
                    }
                }
            }
            .navigationTitle("Host app")
        }
        .fullScreenCover(isPresented: $host.pageOpen) {
            EphemeraPage(config: host.config, route: host.pendingRoute)
                .ignoresSafeArea()
        }
        .onAppear { host.requestNotificationPermission() }
    }
}
