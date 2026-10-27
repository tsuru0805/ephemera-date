# SwiftUI 宿主示例（iOS）

一个空白的 SwiftUI App，把网页包（`web/`）放进 `WKWebView`，实现 [嵌入协议 v1](../../docs/EMBED.md) 的宿主一侧。用来演示「网页包嵌在别人的 App 里」时宿主要做哪些事，也用来在模拟器里把整场约会走一遍。

- App 自己有一个首页（「Host app」），点「Open the date pages」全屏打开约会页；页面发 `close` 时回到这个首页。
- 只依赖系统框架（SwiftUI、WebKit、PhotosUI、SafariServices、UserNotifications），无第三方包。
- 最低 iOS 17。Xcode 26 下编译通过，在 iPhone 17e 模拟器（iOS 26）里跑过整场。

## 目录

```
project.yml                    xcodegen 描述（改了它才需要 `xcodegen generate`）
EphemeraHost.xcodeproj         生成好的工程，直接用 Xcode 打开
EphemeraHost/
  EphemeraHostApp.swift        入口；本地通知的前台展示与点击
  HostState.swift              配置（页面地址、API 地址、口令）、消息记录、event → 本地通知
  HostHomeView.swift           宿主自己的首页
  EphemeraPage.swift           SwiftUI 包装；scenePhase → lifecycle
  EphemeraViewController.swift 协议的宿主一侧（WKWebView + 原生桥）
  PhotoFile.swift              选中的照片 → pickPhoto 回包的 file
scripts/
  run-local.sh                 在本机起引擎 + 托管网页包（同源）
  ai_date.py                   AI 那一侧：经 MCP 写一场约会、寄出、结束（只用标准库）
```

## 跑起来

### 1. 引擎和网页包

在仓库根目录：

```bash
python3 -m venv .venv && .venv/bin/pip install -e .
(cd web && npm ci && npm run build)
EPHEMERA_BIN=$PWD/.venv/bin/ephemera-date examples/swiftui-host/scripts/run-local.sh
```

`run-local.sh` 起两个进程：

| 进程 | 地址 | 说明 |
|---|---|---|
| `ephemera-date serve` | `127.0.0.1:18871` | 数据目录默认 `/tmp/ephemera-host-data`；地点搜索关掉（`EPHEMERA_PLACES_PROVIDER=none`），不出网 |
| `web/scripts/serve.mjs` | `http://127.0.0.1:18870/app/` | 托管 `web/dist`，并把 `/api`、`/mcp` 转给引擎——页面和引擎同源，不用设 `EPHEMERA_ALLOWED_ORIGINS` |

口令默认 `her-host-token`（页面侧）/ `ai-host-token`（AI 侧），可用同名环境变量覆盖。端口用 `ENGINE_PORT` / `WEB_PORT` 改。

页面和引擎分开部署（不同源）时：`init.apiBase` 填引擎地址，并在引擎上设 `EPHEMERA_ALLOWED_ORIGINS=<页面的来源>`。

### 2. 写一场约会

```bash
cd examples/swiftui-host/scripts
python3 ai_date.py write    # 今天的约会：4 站（其中一站是「一件事」）、准备清单、契约、小卡，寄出
python3 ai_date.py close    # AI 结束约会，收进纪念盒
python3 ai_date.py clear    # 结束/删除所有进行中的约会
```

站的时间写在「现在之前几十分钟」，所以每一站马上可以检票。时区要和引擎一致：引擎设了 `EPHEMERA_TZ` 时，这里也设同一个值（接近午夜时建议两边都设成一个白天的时区，免得约会日跨天）。

### 3. 编译、装进模拟器

Xcode：打开 `EphemeraHost.xcodeproj`，选一个 iPhone 模拟器，Run。在宿主首页的「Credential」里填 `her-host-token`，点「Open the date pages」。

命令行：

```bash
cd examples/swiftui-host
xcodebuild -project EphemeraHost.xcodeproj -scheme EphemeraHost \
  -destination 'platform=iOS Simulator,name=<模拟器名>' -derivedDataPath /tmp/ephemera-host-build build
xcrun simctl install <udid> /tmp/ephemera-host-build/Build/Products/Debug-iphonesimulator/EphemeraHost.app
SIMCTL_CHILD_EPHEMERA_CREDENTIAL=her-host-token xcrun simctl launch <udid> com.example.ephemerahost
```

真机：在 Xcode 里给 target 选自己的 Team；页面地址改成 Mac 的局域网地址（`run-local.sh` 只监听 127.0.0.1，真机要改成监听局域网并给引擎设口令，见仓库 README）。

### 配置

按顺序取第一个有值的：

| 项 | 启动环境变量 | 首页输入框 | 默认 |
|---|---|---|---|
| 页面地址 | `EPHEMERA_PAGE_URL` | Page | `http://127.0.0.1:18870/app/` |
| 引擎地址（`init.apiBase`） | `EPHEMERA_API_BASE` | API base | 页面的来源 |
| 口令（`init.credential`） | `EPHEMERA_CREDENTIAL` | Credential | 无（不填不能打开） |

页面地址和引擎地址存在 `UserDefaults`；口令只放在内存里（正式 App 应放 Keychain）。口令只经 `init` 传给页面，不进 URL；消息记录里显示成 `•••`。

`simctl launch` 时环境变量要加 `SIMCTL_CHILD_` 前缀。

## 宿主做了什么

页面检测到 `window.webkit.messageHandlers.ephemera` 存在就进入原生模式。

| 方向 | 消息 | 宿主的做法 |
|---|---|---|
| 页面 → 宿主 | 通道 | `WKUserContentController` 在 `.page` 世界注册 `ephemera`；页面发的是 JSON 字符串。只接受主框架、且来源（协议/主机/端口）等于所加载页面的消息 |
| 宿主 → 页面 | 通道 | `evaluateJavaScript("window.ephemera && window.ephemera.receive(<JSON>)")`，JSON 直接作为对象字面量传入 |
| ← `ready` | | 回 `init {apiBase, credential, theme:"ivory", safeArea, route?}`。页面重新加载会再发 `ready`，宿主每次都回 `init` |
| → `keyboard` | `{height}` | 监听 `keyboardWillChangeFrame` / `keyboardWillHide`，报键盘与 web view 重叠的高度（pt，即页面的 CSS px） |
| → `safeArea` | | `init` 里带一次；`viewSafeAreaInsetsDidChange` 变化时再发。web view 本身铺满屏幕（`contentInsetAdjustmentBehavior = .never`），安全区由页面自己让 |
| → `lifecycle` | | SwiftUI `scenePhase`：`.active` → `active`，`.background` → `background`，`.inactive` 不发 |
| → `navigate{page:"back"}` | | 从屏幕左缘 24pt 内开始的右滑（`UIPanGestureRecognizer` + 起点判断）。WebKit 自带的前进后退手势关掉 |
| ← `close` | | 关掉全屏页，回到宿主首页 |
| ← `pickPhoto` | | `PHPickerViewController`（`.images`，1 张，`preferredAssetRepresentationMode = .current` 取原文件）。回包 `{ok:true, file:{name, mime, size, width, height, data}}`，`data` 是原文件字节的 base64，不缩不转码；HEIC 原样回。取消（点 ✕ 或下滑关掉）回 `{ok:false, cancelled:true}`。图库里只有 GIF/TIFF 等页面不收的格式时，向系统要一份 JPEG。宽高取 ImageIO 的像素宽高，EXIF 方向 5–8 时对调 |
| ← `event` | `{kind, planId}` | 发一条本地通知（不带声音）。点通知：页面开着就发 `navigate`，没开就带 `init.route` 打开。`kind` → 落点与引擎 webhook 的 `navigate` 一致：`envelope`→`seal`，`telegram_*`/`cancel`→`telegrams`，`close`/`late_written`→`box` |
| ← `openExternal` | `{url}` | 只放行 `https`，用 `SFSafariViewController` 打开；其他协议记一行日志不处理 |

其他：

- **web view 不离开页面的来源**：`decidePolicyFor` 只放行同源、`about:`/`blob:`/`data:` 与子框架；其他导航取消，`https` 的转给 `SFSafariViewController`。`window.open` 同样处理。原生桥因此不会暴露给别的站点。
- **陀螺仪权限**：页面里有几张纸会随手机倾斜（`DeviceOrientationEvent`）。不处理时 WebKit 会弹系统框「127.0.0.1 Would Like to Access Motion and Orientation」。示例实现了 `WKUIDelegate` 的 `requestDeviceOrientationAndMotionPermissionFor`：页面自己的来源直接允许，其他拒绝。
- **背景色**：web view 和控制器背景设成页面底色 `#FBF6EF`，加载时不闪白。
- **声音**：`mediaTypesRequiringUserActionForPlayback = .all`，本地通知不带声音。
- **网页内容进程被系统回收**：`webViewWebContentProcessDidTerminate` 里重新加载（页面会再发 `ready`，宿主再发 `init`）。
- **加载失败**：显示一句错误和「Retry」「Close」，避免卡在一个关不掉的白页。
- **调试**：Debug 构建 `isInspectable = true`，可用 Safari「开发」菜单检查页面。协议消息记在宿主首页的「Messages」里，同时写系统日志：`xcrun simctl spawn <udid> log show --last 5m --info --predicate 'subsystem == "ephemera.host"'`。
- **`EPHEMERA_HOST_KEYBOARD=off`**（启动环境变量）：宿主不发 `keyboard`。WKWebView 的 `visualViewport` 会随键盘缩小，页面以它为准，宿主报的高度只在 `visualViewport` 不缩时才用，所以开与关表现应当一致；这个开关用来核对这一点。
