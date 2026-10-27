import PhotosUI
import SafariServices
import UIKit
import WebKit

/// Host side of the embedding protocol v1 (docs/EMBED.md) over WKWebView.
///
/// page → host: `window.webkit.messageHandlers.ephemera.postMessage(<JSON string>)`
///              (the page detects native mode by the presence of that handler)
/// host → page: `window.ephemera.receive(<message object>)` via evaluateJavaScript
///
/// What this controller does:
///   ready        → init {apiBase, credential, theme, safeArea, route}
///   close        → closes the page (back to the host's own page)
///   pickPhoto    → PHPickerViewController; reply {ok, file{name,mime,size,width,height,data}} or {ok:false, cancelled:true}
///   event        → local notification (HostState.notify) + log
///   openExternal → https only, SFSafariViewController
///   keyboard     ← system keyboard frame (overlap with the web view, points)
///   safeArea     ← view.safeAreaInsets
///   lifecycle    ← scenePhase (EphemeraPage)
///   left edge swipe → navigate {page:"back"}; the page goes back in its own history and sends close at the bottom
final class EphemeraViewController: UIViewController {
    private let config: HostConfig
    private let initialRoute: [String: Any]?
    private weak var host: HostState?
    var onClose: (() -> Void)?

    private var webView: WKWebView!
    private var pageOrigin: (scheme: String, host: String, port: Int)?
    private var counter = 0
    private var pageReady = false
    private var lastKeyboard: CGFloat = -1
    private var lastInsets: UIEdgeInsets?
    private var pickRequestId: String?
    private weak var edgePan: UIPanGestureRecognizer?
    private static let edgeWidth: CGFloat = 24
    private let failureView = UIStackView()
    private let failureLabel = UILabel()

    /// The page's background (web/src/app/_layout.tsx root), so the view does not flash white while loading.
    private static let pageBackground = UIColor(red: 0xFB / 255, green: 0xF6 / 255, blue: 0xEF / 255, alpha: 1)

    init(config: HostConfig, route: [String: Any]?, host: HostState) {
        self.config = config
        self.initialRoute = route
        self.host = host
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    deinit {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "ephemera", contentWorld: .page)
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - setup

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.pageBackground

        let ucc = WKUserContentController()
        ucc.add(WeakMessageHandler(self), contentWorld: .page, name: "ephemera")
        let cfg = WKWebViewConfiguration()
        cfg.userContentController = ucc
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = .all

        webView = WKWebView(frame: view.bounds, configuration: cfg)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.isOpaque = false
        webView.backgroundColor = Self.pageBackground
        webView.scrollView.backgroundColor = Self.pageBackground
        // the page lays itself out with the safe area it gets from the host; the web view itself covers the screen
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // back is the page's own history (navigate back), not WebKit's back/forward list
        webView.allowsBackForwardNavigationGestures = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }   // Safari ▸ Develop ▸ Simulator
        #endif
        view.addSubview(webView)

        // a pan that must start within the left edge strip (UIScreenEdgePanGestureRecognizer behaves the same on a
        // device, but ignores synthesized touches, so simulator automation could not exercise it)
        let edge = UIPanGestureRecognizer(target: self, action: #selector(edgeSwipe(_:)))
        edge.delegate = self
        view.addGestureRecognizer(edge)
        edgePan = edge

        setupFailureView()

        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(keyboardChange(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        nc.addObserver(self, selector: #selector(keyboardHide(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)

        load()
    }

    private func load() {
        guard let url = URL(string: config.pageURL), let scheme = url.scheme, let h = url.host else {
            showFailure("Page URL is not valid: \(config.pageURL)")
            return
        }
        pageOrigin = (scheme.lowercased(), h.lowercased(), url.port ?? (scheme == "https" ? 443 : 80))
        failureView.isHidden = true
        pageReady = false
        webView.load(URLRequest(url: url))
        host?.record("load \(url.absoluteString)")
    }

    private func setupFailureView() {
        failureLabel.numberOfLines = 0
        failureLabel.textAlignment = .center
        failureLabel.font = .preferredFont(forTextStyle: .body)
        let retry = UIButton(type: .system, primaryAction: UIAction(title: "Retry") { [weak self] _ in self?.load() })
        let close = UIButton(type: .system, primaryAction: UIAction(title: "Close") { [weak self] _ in self?.onClose?() })
        failureView.axis = .vertical
        failureView.spacing = 12
        failureView.alignment = .center
        [failureLabel, retry, close].forEach(failureView.addArrangedSubview)
        failureView.translatesAutoresizingMaskIntoConstraints = false
        failureView.isHidden = true
        view.addSubview(failureView)
        NSLayoutConstraint.activate([
            failureView.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            failureView.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            failureView.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -48),
        ])
    }

    private func showFailure(_ text: String) {
        failureLabel.text = text
        failureView.isHidden = false
        host?.record("load failed: \(text)")
    }

    // MARK: - host → page

    /// A navigate asked for before the page said `ready` (e.g. a notification tapped while it loads):
    /// held here and sent right after `init`.
    private var heldNavigates: [[String: Any]] = []

    func navigate(_ target: [String: Any]) {
        if pageReady { send("navigate", target) } else { heldNavigates.append(target) }
    }

    /// Send a host → page message (window.ephemera exists only after the page has said `ready`).
    func send(_ type: String, _ payload: [String: Any] = [:]) {
        counter += 1
        let msg: [String: Any] = ["v": 1, "id": "h\(counter)", "type": type, "payload": payload]
        evaluate(msg, label: type)
    }

    private func reply(_ id: String, _ body: [String: Any]) {
        var msg = body
        msg["id"] = id
        evaluate(msg, label: "reply \(id)")
    }

    private func evaluate(_ msg: [String: Any], label: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: msg), let json = String(data: data, encoding: .utf8) else { return }
        // JSON is a valid JavaScript expression; receive() takes the object as is
        webView.evaluateJavaScript("window.ephemera && window.ephemera.receive(\(json))") { [weak self] _, err in
            if let err { self?.host?.record("send \(label) failed: \(err.localizedDescription)") }
        }
        let shown = json.count > 300 ? String(json.prefix(300)) + "… (\(json.count) chars)" : json
        host?.record("→ \(label == "init" ? redacted(shown) : shown)")
    }

    private func redacted(_ s: String) -> String {
        guard !config.credential.isEmpty else { return s }
        return s.replacingOccurrences(of: config.credential, with: "•••")
    }

    func sendLifecycle(_ state: String) {
        guard pageReady else { return }
        send("lifecycle", ["state": state])
    }

    private func insetsPayload() -> [String: Any] {
        let i = view.safeAreaInsets
        return ["top": i.top, "right": i.right, "bottom": i.bottom, "left": i.left]
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        guard pageReady, view.safeAreaInsets != lastInsets else { return }
        lastInsets = view.safeAreaInsets
        send("safeArea", insetsPayload())
    }

    // MARK: - keyboard

    @objc private func keyboardChange(_ n: Notification) {
        guard let end = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue,
              let screen = view.window?.screen else { return }
        // the part of the web view the keyboard covers, in points (= CSS px at the page's scale 1)
        let kb = view.convert(end, from: screen.coordinateSpace)
        reportKeyboard(max(0, view.bounds.maxY - kb.minY))
    }

    @objc private func keyboardHide(_ n: Notification) { reportKeyboard(0) }

    private func reportKeyboard(_ h: CGFloat) {
        let height = h.rounded()
        // EPHEMERA_HOST_KEYBOARD=off: do not report (the page then reads visualViewport); for comparing the two
        guard pageReady, height != lastKeyboard, ProcessInfo.processInfo.environment["EPHEMERA_HOST_KEYBOARD"] != "off" else { return }
        lastKeyboard = height
        send("keyboard", ["height": height])
    }

    // MARK: - back gesture

    @objc private func edgeSwipe(_ g: UIPanGestureRecognizer) {
        guard g.state == .ended else { return }
        let t = g.translation(in: view), v = g.velocity(in: view)
        guard t.x > 60 || v.x > 400 else { return }
        if pageReady { send("navigate", ["page": "back"]) } else { onClose?() }
    }

    // MARK: - page → host

    fileprivate func handle(_ message: WKScriptMessage) {
        // only the main frame of the page we loaded may use the bridge
        let o = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, let po = pageOrigin,
              o.protocol.lowercased() == po.scheme, o.host.lowercased() == po.host,
              (o.port == 0 ? (po.scheme == "https" ? 443 : 80) : o.port) == po.port else {
            host?.record("ignored a message from \(o.protocol)://\(o.host):\(o.port)")
            return
        }
        guard let text = message.body as? String, let data = text.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            host?.record("ignored a message that is not JSON")
            return
        }
        host?.record("← \(text.count > 300 ? String(text.prefix(300)) + "…" : text)")
        guard let type = obj["type"] as? String else { return }   // a reply to one of ours: logged above
        let id = obj["id"] as? String ?? ""
        let payload = obj["payload"] as? [String: Any] ?? [:]
        switch type {
        case "ready":
            pageReady = true
            lastKeyboard = -1
            lastInsets = view.safeAreaInsets
            var initPayload: [String: Any] = [
                "apiBase": config.resolvedAPIBase,
                "credential": config.credential,
                "theme": "ivory",
                "safeArea": insetsPayload(),
            ]
            if let r = initialRoute { initPayload["route"] = r }
            send("init", initPayload)
            heldNavigates.forEach { send("navigate", $0) }      // the page queues them until init is done
            heldNavigates.removeAll()
        case "close":
            onClose?()
        case "pickPhoto":
            pickPhoto(id: id)
        case "event":
            let kind = payload["kind"] as? String ?? "event"
            host?.notify(kind: kind, planId: payload["planId"] as? Int)
        case "openExternal":
            if let s = payload["url"] as? String, let url = URL(string: s), url.scheme?.lowercased() == "https" {
                present(SFSafariViewController(url: url), animated: true)
            } else {
                host?.record("openExternal refused (https only)")
            }
        default:
            if !id.isEmpty { reply(id, ["ok": false, "error": "unknown type \(type)"]) }
        }
    }

    // MARK: - photos

    private func pickPhoto(id: String) {
        guard pickRequestId == nil else { reply(id, ["ok": false, "error": "busy"]); return }
        pickRequestId = id
        var cfg = PHPickerConfiguration()
        cfg.filter = .images
        cfg.selectionLimit = 1
        cfg.preferredAssetRepresentationMode = .current      // the original file (HEIC stays HEIC)
        let picker = PHPickerViewController(configuration: cfg)
        picker.delegate = self
        picker.presentationController?.delegate = self      // swiped down = cancelled
        present(picker, animated: true)
    }

    private func finishPick(_ body: [String: Any]) {
        guard let id = pickRequestId else { return }
        pickRequestId = nil
        reply(id, body)
    }
}

// MARK: - WKScriptMessageHandler (weak, so the content controller does not keep the controller alive)

private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: EphemeraViewController?
    init(_ t: EphemeraViewController) { target = t }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.handle(message)
    }
}

// MARK: - navigation: the web view never leaves the page's origin

extension EphemeraViewController: WKNavigationDelegate, WKUIDelegate {
    private func sameOrigin(_ url: URL) -> Bool {
        guard let po = pageOrigin, let s = url.scheme?.lowercased(), let h = url.host?.lowercased() else { return false }
        return s == po.scheme && h == po.host && (url.port ?? (s == "https" ? 443 : 80)) == po.port
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        let scheme = url.scheme?.lowercased() ?? ""
        if sameOrigin(url) || ["about", "blob", "data"].contains(scheme) || action.targetFrame?.isMainFrame == false {
            decisionHandler(.allow)
            return
        }
        // anything else would take the bridge to another site: stay, and open https links outside
        decisionHandler(.cancel)
        if scheme == "https" { present(SFSafariViewController(url: url), animated: true) }
        host?.record("navigation to \(url.absoluteString) kept out of the web view")
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, url.scheme?.lowercased() == "https" {
            present(SFSafariViewController(url: url), animated: true)
        }
        return nil
    }

    /// The pages tilt a few papers with the device (DeviceOrientationEvent). Without this, WebKit asks the user with
    /// a system alert naming the page's host ("127.0.0.1 Would Like to Access Motion and Orientation").
    /// The host decides instead: granted for the page's own origin, denied for anything else.
    func webView(_ webView: WKWebView, requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        guard let po = pageOrigin else { decisionHandler(.deny); return }
        let port = origin.port == 0 ? (po.scheme == "https" ? 443 : 80) : origin.port
        let same = origin.protocol.lowercased() == po.scheme && origin.host.lowercased() == po.host && port == po.port
        decisionHandler(same ? .grant : .deny)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showFailure("Could not open the page.\n\(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showFailure("The page stopped loading.\n\(error.localizedDescription)")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        host?.record("web content process ended; reloading")
        pageReady = false
        webView.reload()
    }
}

extension EphemeraViewController: UIGestureRecognizerDelegate {
    func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        guard g === edgePan, let pan = g as? UIPanGestureRecognizer else { return true }
        let start = pan.location(in: view).x - pan.translation(in: view).x
        let v = pan.velocity(in: view)
        return start <= Self.edgeWidth && v.x > abs(v.y)
    }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}

extension EphemeraViewController: UIAdaptivePresentationControllerDelegate {
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        finishPick(["ok": false, "cancelled": true])
    }
}

extension EphemeraViewController: PHPickerViewControllerDelegate {
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let provider = results.first?.itemProvider else {
            finishPick(["ok": false, "cancelled": true])
            return
        }
        PhotoFile.load(from: provider) { [weak self] result in
            DispatchQueue.main.async {
                switch result {
                case .success(let file): self?.finishPick(["ok": true, "file": file])
                case .failure(let err): self?.finishPick(["ok": false, "error": err.message])
                }
            }
        }
    }
}
