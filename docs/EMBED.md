# 嵌入协议（v1）

> **状态**：协议 v1。页面侧实现在 `web/src/runtime/`（`protocol.ts`、`host.ts`、`session.ts`），宿主示例在 [`web/examples/iframe-host.html`](../web/examples/iframe-host.html)。引擎侧已经实现的部分单独标出。

网页包可以单独在浏览器里打开，也可以放进宿主 App 的内嵌网页窗口（iOS `WKWebView`、Android `WebView`、或网页里的 `<iframe>`）。嵌入时，页面与宿主之间只通过下面的消息通信。

## 0. 页面怎么知道自己在哪里

页面加载时按下面的顺序判断一次：

| 条件 | 模式 |
|---|---|
| 地址带 `?demo=1`（或试玩构建） | 试玩：页面里的假数据 + 快进时钟，不联网，不要口令。同一个标签页里刷新或跳页都留在试玩里，`?demo=0` 退出 |
| 地址带 `?embed=native`，或页面加载时已经有 `window.webkit.messageHandlers.ephemera`、`window.ReactNativeWebView`、`window.EphemeraHost` 之一 | 原生桥 |
| 页面在别的窗口里（`window.parent !== window`） | iframe |
| 都不是 | 单独打开：自带登录页 |

原生桥要在页面加载**之前**就绪（例如 `WKUserScript` 在文档开始时注入、`addJavascriptInterface` 在 `loadUrl` 之前），否则页面会当成单独打开；来不及时在地址上加 `?embed=native`。

## 1. 消息格式

```
{ "v": 1, "id": "<消息编号>", "type": "<类型>", "payload": { ... } }
```

- 请求类消息必有回包：`{ "id": "<同一编号>", "ok": true, "result": ... }` 或 `{ "id": "...", "ok": false, "error": ... }`。
- 页面发给宿主的请求只有 `pickPhoto`，宿主有 **5 分钟**回包（等人选图）；其余请求 **10 秒**内没有回包视为失败。
- 宿主发给页面的每条消息，页面都回一个回包（见第 4 节）。
- `v` 不是 `1`、`type` 不认识的消息，页面直接丢掉。

### 1.1 iframe：登记宿主来源

页面只跟一个登记过的宿主来源说话：

- 宿主在页面地址上带 `?host=<宿主来源>`，例如 `https://app.example.com/app/?host=https%3A%2F%2Fhost.example`。页面取它的来源部分（`scheme://host[:port]`）。
- 浏览器提供 `location.ancestorOrigins` 时（Chrome、Safari），页面再拿它的第一项（直接父窗口的来源）核对：与 `?host=` 不一致=不登记任何来源。框住页面的网页冒充不了别的来源。
- 不带 `?host=` 时，页面用 `ancestorOrigins` 的第一项；浏览器没有 `ancestorOrigins`（Firefox）时就登记不上，所以**请一律带 `?host=`**。
- 没登记上来源的页面一句话都不发（连 `ready` 也不发），也不接收任何消息。
- 收消息：同时校验 `event.origin` 等于登记的来源，**且** `event.source === window.parent`。发消息：`window.parent.postMessage(msg, <登记的来源>)`，不用 `"*"`。宿主这边同样按页面的来源 `postMessage`，不用 `"*"`。

### 1.2 原生桥

- 页面 → 宿主：页面把消息转成 JSON 字符串，按顺序找第一个存在的出口发出：
  1. `window.webkit.messageHandlers.ephemera.postMessage(json)`（iOS `WKWebView`，消息处理器名叫 `ephemera`）
  2. `window.ReactNativeWebView.postMessage(json)`（react-native-webview）
  3. `window.EphemeraHost.postMessage(json)`（Android `addJavascriptInterface(…, "EphemeraHost")`）
- 宿主 → 页面：调用 `window.ephemera.receive(msg)`，`msg` 可以是对象，也可以是 JSON 字符串（例如 iOS `evaluateJavaScript("window.ephemera.receive(" + json + ")")`）。
- 原生桥上页面不核对来源：桥本身就是边界。宿主只对自己打包的页面或登记的域名开放桥；页面要跳外部链接时走 `openExternal`，由宿主用外部浏览器打开，页面自己不离开；如果宿主的网页窗口还是跳到了别处，先撤掉桥。

## 2. 握手

1. 页面加载完成 → 页面发 `ready { v: 1 }`。
2. 宿主回 `init { apiBase, credential, theme?, fonts?, route?, safeArea? }`。
3. 页面用 `credential` 请求 `<apiBase>/api/config`，成功后才回包、开始拉数据。`init` 之前收到的落点（`navigate`）排队，`init` 成功后按顺序处理；`init` 里带的 `route` 排在最前。

`init` 的回包：

| 结果 | 回包 |
|---|---|
| 成功 | `{ "id", "ok": true, "result": { "v": 1 } }` |
| 少 `apiBase` 或 `credential`，或 `apiBase` 不是 `http(s)://` 开头 | `{ "ok": false, "error": "init 需要 apiBase 与 credential" }` |
| 口令不对（`/api/config` 回 401） | `{ "ok": false, "error": "口令不对" }` |
| 引擎回了别的错误状态 | `{ "ok": false, "error": "后台没有回应（HTTP <状态码>）" }` |
| 连不上（网络错误、被跨源规则拦下） | `{ "ok": false, "error": "<浏览器给的错误>" }` |

失败后页面显示那句错误，不保留口令；宿主可以再发一次 `init`。

| `init` 字段 | 说明 |
|---|---|
| `apiBase` | 引擎地址，例如 `https://example.com`（页面请求 `<apiBase>/api/...`）；空字符串=与页面同源。页面与引擎不同源时，在**被连的引擎**上设 `EPHEMERA_ALLOWED_ORIGINS=<页面的来源>`（CORS，**引擎侧已实现**，规则见 [API.md](API.md)「跨源（CORS）」）；页面是由另一台引擎在 `/app/` 提供的，还要在**提供页面的那台引擎**上设 `EPHEMERA_WEB_CONNECT_SRC=<被连引擎的来源>`（CSP，见第 9 节） |
| `credential` | 她那侧的口令（`EPHEMERA_HER_TOKEN`），页面以 `Authorization: Bearer` 发出（不用 cookie，也不写进 URL） |
| `theme` | 可选：配色，`ivory`（奶白，默认）/ `blue` / `warm` / `bright`；别的值忽略。她在「我」页里自己选过的配色（存在本机）优先 |
| `fonts` | 可选：v1 收下但不使用（预留） |
| `route` | 可选：初始落点，格式同 `navigate` |
| `safeArea` | 可选：`{top, right, bottom, left}`（像素） |

## 3. 凭据

- 只经 `init` 传。**不进 URL、深链、日志、试玩构建。**
- 页面只放在内存里；宿主发 `logout` 时页面清掉，回到等待 `init` 的状态。
- 单独打开（不在宿主里）时页面走自带登录页，凭据存在浏览器本地存储，可以退出。

## 4. 宿主 → 页面

| 类型 | payload | 回包 | 说明 |
|---|---|---|---|
| `init` | 见上 | 见上 | 握手 |
| `navigate` | `{page, planId?, stopId?, key?}` | `ok:true`；没有 `page` 时 `ok:false, error:"navigate 需要 page"` | 跳到某页。`page` 取值：`home`、`telegrams`、`shelf`、`me`、`backfill`（不用 `planId`），`invite`、`day`、`map`、`box`、`seal`（要 `planId`），`back`（见第 6 节）。约会不存在、已取消或看不到=落到首页并显示「这次约会找不到了」；不认识的 `page`=落到首页并显示「没有这一页」 |
| `lifecycle` | `{state: "active" \| "background"}` | `ok:true`；别的值 `ok:false` | 进后台=停动画；回前台=刷新，并补拉期间错过的事件 |
| `safeArea` | `{top, right, bottom, left}` | `ok:true` | 安全区变化 |
| `keyboard` | `{height}` | `ok:true` | 宿主报告的键盘高度（可视区变化），页面据此让出输入框；`0`=键盘收起。浏览器的 `visualViewport` 随键盘缩小时，页面以 `visualViewport` 为准；宿主报的高度只在 `visualViewport` 不缩时生效，两者不会叠加。宿主从没发过时，页面只用 `visualViewport` |
| `logout` | — | `ok:true` | 页面清掉内存里的凭据 |

**引擎侧已实现**：用户事件（webhook 与网页推送）都带 `navigate` 落点，值目前是 `{page:"seal", planId}`（信封）、`{page:"telegrams", planId:null}`（电报）、`{page:"box", planId}`（纪念盒）。宿主收到事件 webhook 后可以把它原样作为 `navigate` 发给页面。

## 5. 页面 → 宿主

| 类型 | payload | 回包 | 说明 |
|---|---|---|---|
| `ready` | `{v: 1}` | — | 页面可以接 `init` 了 |
| `close` | — | — | 页面内历史已经到底时才发；页面内的返回走页面自己的历史 |
| `pickPhoto` | `{max: 1}` | 见下（5 分钟内） | 请宿主选一张照片 |
| `event` | `{kind, planId}` | — | 需要提醒用户的事件，由宿主自己发通知 |
| `openExternal` | `{url}` | — | 请宿主用外部浏览器打开链接（只发 `http(s)` 链接） |

### 5.1 `pickPhoto`

回包三种：

```
{ "id", "ok": true,  "result": { "file": { "name", "mime", "size", "width", "height", "data" | "url" } } }
{ "id", "ok": false, "cancelled": true }
{ "id", "ok": false, "error": "..." }
```

- `file` 放在 `result.file` 或顶层 `file` 都认。取消也可以写成 `{ "ok": false, "result": { "cancelled": true } }`。
- `data` 是 base64（可以带 `data:<mime>;base64,` 前缀）；`url` 是页面能直接 `fetch` 的地址。页面由引擎在 `/app/` 提供时受 CSP 的 `connect-src` 限制，`url` 只能是 `blob:`、`data:`、同源地址或 `EPHEMERA_WEB_CONNECT_SRC` 里列出的来源；iframe 宿主自己生成的 `blob:` 地址属于宿主的来源，页面取不到，所以 iframe 宿主请用 `data`。
- 只收 `image/jpeg`、`image/png`、`image/heic`、`image/heif`、`image/avif`。**引擎侧已实现**：服务端按文件头再判一次（JPEG、PNG，以及 `ftyp` 盒的 avif/avis 与 heic/heix/heim/heis/hevc/hevx/hevm/hevs/mif1/msf1），不认的回 415。
- 单张 ≤20 MB。超了页面直接提示，不上传（**引擎侧已实现**：服务端超 20 MB 回 413）。
- 回传**原图原比例**，不裁不压；`width` / `height` 必填（页面按原比例取景），缺了页面提示「这张照片读不出宽高，换一张试试」。
- HEIC 由服务端收，宿主不必转码。
- 5 分钟没有回包=页面提示「宿主没有回应选图」。
- 宿主不接管选图时（单独打开），页面用浏览器选图，同一套校验。

### 5.2 `event`

页面在开始时、在前台时每分钟一次、从后台回到前台时，读她那侧的事件列表（`/api/dates/events`），把**还没读过、也还没报过**的事件逐条报给宿主：每条事件只报一次（同一个标签页里记着报过哪些）。`kind` 与事件列表里的 `kind` 相同（例如 `envelope`、`telegram_manual`、`telegram_auto`、`cancel`、`close`、`late_written`，见 [API.md](API.md)），`planId` 是约会编号。宿主据此自己发通知；点通知后可以用 `navigate` 把页面带到对应的页。

## 6. 返回手势

iOS 边缘返回与 Android 返回键由宿主拦截，发 `navigate { page: "back" }` 给页面；页面在自己的历史里后退，到底时发 `close`，宿主再关闭窗口。这样返回手势不会直接跳出宿主。

## 7. 不在宿主里

单独在浏览器里打开时，同一套页面自动使用：自带的返回（到底回首页）、浏览器选图、网页推送（`/api/push/subscribe`，需配置 VAPID）。

## 8. 试玩

`?demo=1` 打开试玩：页面里自带假数据与快进时钟，不连引擎、不要口令，也不发任何嵌入消息。用来先看看，或在宿主里先把窗口、返回手势调通。

## 9. 由引擎提供页面时的安全头

`ephemera-date serve` 在 `/app/` 提供页面时，响应带 `Content-Security-Policy`（完整内容见 [API.md](API.md)「页面 `/app/`」）。跟嵌入有关的两项：

- `frame-ancestors`：默认只有 `'self'`，别的网页用 `<iframe>` 嵌不进来（浏览器拦下）。在引擎上设 `EPHEMERA_EMBED_ORIGINS=<宿主来源>`（逗号分隔可列多个）放行；只收 `scheme://host[:port]`，不接受 `*`。原生 App 的内嵌网页窗口不受这一项限制。
- `connect-src`：默认只能连本引擎（外加 `blob:`、`data:`）。页面要连另一台引擎时，在提供页面的引擎上设 `EPHEMERA_WEB_CONNECT_SRC=<那台引擎的来源>`。

例：宿主网页在 `https://host.example`，引擎在 `https://ephemera.example`，用 `<iframe src="https://ephemera.example/app/?host=https%3A%2F%2Fhost.example">`，引擎上设 `EPHEMERA_EMBED_ORIGINS=https://host.example`；页面和引擎同源，不用设 CORS。

## 10. 宿主接入要点

以下来自 iOS `WKWebView` 宿主示例（[`examples/swiftui-host`](../examples/swiftui-host/)）的实测，其他平台的原生宿主同理。

1. **原生桥与消息时序**：页面加载时检测到 `window.webkit.messageHandlers.ephemera`（或另两个出口，见 1.2 节）才进入原生模式，所以消息处理器要在加载页面之前注册。页面发给宿主的消息是 JSON 字符串，宿主要先解析。`window.ephemera.receive` 在页面发 `ready` 的同时才装上，之前不存在；宿主发给页面的所有消息（包括 `init`）都要在收到 `ready` 之后发，调用时写成 `window.ephemera && window.ephemera.receive(<JSON>)`。
2. **每次 `ready` 都回 `init`**：页面每次重新加载都会再发 `ready`，凭据随之清空。重新加载包括刷新、`WKWebView` 的网页内容进程被系统回收后的重载（`webViewWebContentProcessDidTerminate` 里重新加载）。宿主每收到一次 `ready` 都要再回一次 `init`。
3. **`keyboard` 的取值**：报键盘与 web view 重叠部分的高度，不是键盘整体高度；单位是 pt，等于页面的 CSS px。监听 `keyboardWillChangeFrameNotification` / `keyboardWillHideNotification`，收起时发 `{height: 0}`。web view 铺满屏幕，`scrollView.contentInsetAdjustmentBehavior = .never`，安全区经 `init` / `safeArea` 报给页面，由页面自己让位；否则系统和页面会各让一次。iOS `WKWebView` 的 `visualViewport` 会随键盘缩小，页面此时以它为准，宿主照常发 `keyboard` 即可，页面不会把两者叠加。Android `WebView` 所在 Activity 的 `windowSoftInputMode` 是 `adjustNothing` 时，`visualViewport` 不随键盘变化，宿主**必须**发 `keyboard`，否则输入框会被键盘挡住。
4. **陀螺仪权限**：页面有几张纸随手机倾斜（`DeviceOrientationEvent`）。宿主不处理时，WebKit 会弹系统框，标题里显示页面的主机名（例如「127.0.0.1 Would Like to Access Motion and Orientation」）。实现 `WKUIDelegate` 的 `webView(_:requestDeviceOrientationAndMotionPermissionFor:initiatedByFrame:decisionHandler:)`：页面自己的来源回 `.grant`，其他来源回 `.deny`。
5. **`pickPhoto`**：`PHPickerConfiguration.preferredAssetRepresentationMode = .current` 才拿到原始文件（HEIC 保持 HEIC，不被系统转成 JPEG）；`data` 是原文件字节的 base64，不缩不转码。`width` / `height` 是按 EXIF 方向显示后的像素宽高：方向值 5–8 时把 ImageIO 读出的宽高对调。用户点取消或下滑关掉选择器（`presentationControllerDidDismiss`）都回 `{ok:false, cancelled:true}`，否则页面要等满 5 分钟才放弃。
6. **`event` 的时效**：`event` 只来自页面在前台时每 60 秒一次的轮询（另加启动和回到前台各一次）。页面没开或在后台时不会有 `event`。要及时提醒，宿主的服务端接引擎的事件 webhook（`EPHEMERA_EVENT_WEBHOOK`，见 [API.md](API.md)），由服务端发推送。
7. **关掉 WebKit 自带的返回手势**：`allowsBackForwardNavigationGestures = false`。边缘右滑由宿主拦截后发 `navigate{page:"back"}`（第 6 节）；否则 WebKit 会直接在网页历史里后退，绕过页面的返回逻辑。
8. **web view 不离开页面的来源**：在 `decidePolicyFor` 里只放行页面同源、`about:` / `blob:` / `data:` 与子框架的导航，其他一律取消；`https` 链接交给 `SFSafariViewController` 打开，`window.open` 同样处理。这样原生桥不会暴露给别的站点。页面自己的外链走 `openExternal`（第 5 节）。
9. **本机 http 开发**：iOS 的 ATS 默认拒绝明文 http。开发时连本机或局域网上的引擎，在 `Info.plist` 的 `NSAppTransportSecurity` 里设 `NSAllowsLocalNetworking = YES`；正式发布用 https。
10. **背景色**：web view（`isOpaque = false`、`backgroundColor`、`scrollView.backgroundColor`）和所在视图控制器的背景都设成页面底色 `#FBF6EF`，避免加载时闪白。

## 11. 宿主检查清单

- [ ] iframe：页面地址带 `?host=<宿主来源>`；引擎上 `EPHEMERA_EMBED_ORIGINS` 列了宿主来源。
- [ ] 原生：桥在页面加载前就绪，或地址带 `?embed=native`。
- [ ] 页面 `ready` 之后才发 `init`；`credential` 不放进 URL；`init` 失败时看 `error` 那句话。
- [ ] iframe 场景按页面的来源 `postMessage`，不用 `"*"`。
- [ ] 进后台/回前台发 `lifecycle`。
- [ ] 拦截系统返回手势，发 `navigate{page:"back"}`，收到 `close` 再关窗口。
- [ ] 键盘弹出时发 `keyboard{height}`，收起时发 `keyboard{height:0}`。
- [ ] `pickPhoto` 回原图与宽高（iframe 用 `data`）；取消时回 `cancelled:true`；5 分钟内回包。
- [ ] 收到 `event` 自己发通知；收到 `openExternal` 用外部浏览器打开。
- [ ] 跳外链前撤掉原生桥。
