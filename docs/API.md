# HTTP 接口

`ephemera-date serve` 提供三组接口，另外在 `/app/` 提供页面（源码 `src/ephemera_date/http.py`、`src/ephemera_date/server.py`、`src/ephemera_date/webapp.py`）：

| 组 | 路径 | 谁用 | 口令 |
|---|---|---|---|
| 她那侧 | `/api/*` | 页面、宿主 App | `EPHEMERA_HER_TOKEN` |
| AI 侧 | `/context`、`/context/*` | 自建网关 | `EPHEMERA_AI_TOKEN` |
| AI 侧 | `/mcp` | MCP 客户端（Streamable HTTP） | `EPHEMERA_AI_TOKEN` |
| 页面 | `/app/`（`/` 跳转到这里） | 浏览器、宿主 App 的内嵌网页窗口 | 不要口令（静态文件；页面发出的 `/api/*` 请求照样要口令） |

## 鉴权

- 口令走请求头 `Authorization: Bearer <口令>`。
- AI 侧（`/mcp`、`/context`、`/context/*`）另外认 URL 参数 `?key=<EPHEMERA_AI_TOKEN>`，给填不了请求头的 MCP 客户端（如 claude.ai 连接器）用。请求头和 `?key=` 有一个对就通过。她那侧 `/api/*` 不认 `?key=`。
- `?key=` 的风险：URL 可能留在反向代理、隧道服务的访问日志和浏览器历史里。能设请求头时优先用请求头。引擎自己的日志（含 uvicorn 访问日志）把 `key=` 的值打成 `***`。
- 一侧的口令在另一侧无效（401）。两个口令相同时服务拒绝启动。
- 某一侧没设口令时，那一侧只接受本机请求：`Host` 头与对端地址都必须是 `127.0.0.1` / `localhost` / `::1`。经隧道或端口转发进来的请求（`Host` 是外部域名）一律 401。
- 监听非本机地址（如 `--host 0.0.0.0`）必须两个口令都设，否则拒绝启动。

## 错误格式

全部错误响应是 JSON：`{"detail": ...}`。`detail` 是一句中文，或对象 `{code, text[, op_index, field]}`（她的写操作、地点、地图、推送订阅）。

- 401：口令缺失或不对。
- 404：约会不存在。**构思中的约会与不存在的约会回答相同的 404**。
- 503 + `code`：适配器没配置或暂时用不了（`not_configured`、`no_basemap` 等），`text` 可直接显示。配置写错（`EPHEMERA_PLACES_PROVIDER` 不认识、`EPHEMERA_*_ADAPTER` 导入不了等）是 `code=bad_config`，`text` 说明哪个变量写错。配置问题不会回 500。

## 跨源（CORS）

- 默认不发任何 CORS 响应头。
- 设 `EPHEMERA_ALLOWED_ORIGINS=https://app.example.com[,…]` 后，只对列出的来源回 `Access-Control-Allow-Origin: <该来源>`（加 `Vary: Origin`），不回 `*`；`*` 写进列表也不生效。
- 预检（`OPTIONS`）允许的请求头：`Authorization`、`Content-Type`；方法：`GET` `POST` `PUT` `PATCH` `DELETE`。未列出的来源或其他请求头，预检回 400。
- 不用凭据模式（不发 `Access-Control-Allow-Credentials`）：口令只走 `Authorization` 请求头，引擎不用 cookie。
- CORS 不是鉴权：列出的来源照样要带口令。

## 页面 `/app/`

网页包（`web/` 构建出的静态文件）由 `serve` 在 `/app/` 提供。路由排在 `/api`、`/context`、`/mcp` 之后，不会盖住它们。

- `GET /`、`GET /app` → 302 到 `/app/`。
- `GET|HEAD /app/<路径>`：文件存在就直接给；不存在的路径是页面里的一页，回 `index.html`（单页回落）。`/app/_expo/` 与 `/app/assets/` 下不存在的文件回 404，不回 `index.html`（这两处是带内容指纹的构建产物，回 HTML 会被当成脚本缓存一年）。这两个目录名按原样大小写匹配，大小写不同的（如 `/app/ASSETS/…`）一律 404，在不分大小写的文件系统上也一样。
- 发出去的每个文件（包括 `index.html` 本身与单页回落）都要求真实路径在网页包目录里：`..`、反斜杠、指向目录外的符号链接回 404。
- 其他方法（`POST` 等）回 405 与 `Allow: GET, HEAD`。
- 类型：`.wasm`=`application/wasm`，`.woff2`=`font/woff2`，`.js`=`text/javascript`，`.html`=`text/html; charset=utf-8`。
- 缓存：`/app/_expo/*`、`/app/assets/*` 是 `public, max-age=31536000, immutable`；其余（含 `index.html`、`sw.js`、`canvaskit.wasm`）是 `no-cache`。都带 `ETag`；`If-None-Match` 按弱比较（忽略 `W/`）对上或是 `*` 时回 304。
- 没有网页包（`EPHEMERA_WEB_DIR` 或包里的 `ephemera_date/web/` 下没有 `index.html`）时回 503 和一句纯文本说明怎么构建，不回 500。
- 只有 `/` 与 `/app/` 的响应带安全头（文件、回落、跳转、304、404、405、503 都带；`/api` 等接口不带）：

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
  img-src 'self' blob: data:; font-src 'self'; connect-src 'self' blob: data: <EPHEMERA_WEB_CONNECT_SRC>;
  worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' <EPHEMERA_EMBED_ORIGINS>
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

| 变量 | 默认 | 说明 |
|---|---|---|
| `EPHEMERA_WEB_DIR` | 包里的 `ephemera_date/web/` | 网页包目录（构建好的 `web/dist`）。包里有没有页面见 `ephemera_date/_build.json` 与 README「三种装法」 |
| `EPHEMERA_EMBED_ORIGINS` | 不设=只有 `'self'` | 允许用 `<iframe>` 嵌入 `/app/` 的宿主来源，逗号分隔，例如 `https://host.example,https://b.example:8443`；写进 `frame-ancestors`。原生 App 的内嵌网页窗口不受它管 |
| `EPHEMERA_WEB_CONNECT_SRC` | 不设=只有本引擎 | `/app/` 的页面除本引擎外还要连的引擎来源，逗号分隔；写进 `connect-src`。只在「用这台引擎提供的页面去连另一台引擎」时要设 |

两个列表都按 URL 解析，只收 `http(s)://host[:port]` 形式的来源（协议与主机名不分大小写，统一写成小写；端口 1–65535）；`*`、带路径/查询/用户名的、端口不对的、不是 http(s) 的值丢掉，启动日志里各有一行警告。

`EPHEMERA_WEB_CONNECT_SRC` 与 `EPHEMERA_ALLOWED_ORIGINS` 方向相反：`EPHEMERA_ALLOWED_ORIGINS` 设在**被连的引擎**上，列出哪些页面来源可以跨源调用它（CORS）；`EPHEMERA_WEB_CONNECT_SRC` 设在**提供页面的引擎**上，列出它的页面可以去连哪些别的引擎（CSP）。页面要连哪台引擎是登录或宿主 `init` 时才定的，提供页面的引擎事先不知道，所以没法从配置推导，要单独写。

## 她那侧 `/api/*`

她那侧读到的一律是**投影**：按公开规则裁过的视图，未公开的地点、线索、内容不在里面。

### 配置

`GET /api/config`

| 字段 | 说明 |
|---|---|
| `title` | 固定 `"Ephemera"` |
| `tz` | 生效的时区名 |
| `her` / `him` | 称呼（`EPHEMERA_HER` / `EPHEMERA_HIM`），默认 `她` / `他` |
| `her_en` / `him_en` | 英文句子里的称呼（`EPHEMERA_HER_EN` / `EPHEMERA_HIM_EN`），默认 `Her` / `Him`；只给页面用（如信上的「Dear …,」），引擎自己写的中文不用它 |
| `together_since` | `YYYY-MM-DD` 或 `null` |
| `write_request_available` | 是否显示「请他补写」入口（至少配好一条 AI 待办路） |
| `ai_channels` | 配好的待办路：`pull` / `context` / `webhook` 的子集 |
| `ai_activity` | `{pull, context}`：各路最近一次被 AI 使用的时刻（epoch 秒或 `null`），只用于显示 |
| `web_push` | 网页推送是否可用 |
| `vapid_public_key` | 网页推送订阅用的公钥，或 `null` |
| `places` / `map` / `art` | 地点搜索、地图、现画三个适配器是否配置 |
| `place_service` | `{available, provider, fallback, supports_autocomplete, attribution, store_policy[, error]}`：页面据 `supports_autocomplete` 决定边输边搜还是点「搜索」才查（OSM 恒为 false），并显示 `attribution` 署名 |
| `map_status` | `{available, ready, reason, text, …}`：例如还没建底图时 `ready=false, reason="no_basemap"` |

### 约会

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/dates` | `{plans:[...]}`：已寄出、当天、已结束的约会（取消的不在这里，只在事件列表）。每份是投影 |
| GET | `/api/dates/preparing` | `{plans:[...]}`：构思中且没过日子的约会，只有进度（几站、各部分写没写、还缺什么、上次动笔时间）与她留过的话，没有名字与内容 |
| POST | `/api/dates/{id}/note` | `{text}`：给构思中的约会留一句话（≤100 字，每个约会最多 30 句） |
| GET | `/api/dates/{id}` | 单个约会的投影 |
| POST | `/api/dates/{id}/her/open` | 记录她第一次「拆开」的时刻（幂等），返回投影。拆开即读过信：同时把这次约会的信封事件（`envelope`）标为已读（已读过的不改时刻）；电报等其他事件不动，AI 待办（`/context`）与事件 webhook、网页推送不受影响 |
| GET | `/api/dates/events?plan={id}` | `{events:[{id, plan_id, kind, text, created_at, read_at, ref_stop}]}`（`plan` 可省） |
| POST | `/api/dates/events/read` | `{ids:[...]}`：标记已读，返回 `{marked: N}` |
| GET | `/api/dates/kinds` | 站的 19 个大类与建议细类 |
| GET | `/api/dates/{id}/stops/{stop_id}/art?v=ink\|inv` | 这一站的现画（PNG）；只有地点已公开且画好了才有，否则 404 |
| GET | `/api/dates/{id}/map` | 约会地图（只画已公开的站）；另带 `unplotted`：没画上的站及原因。`layers.ferry` = 范围内的轮渡航线；`legs[].has_ferry` / `legs[].ferry[]`（`{pts, meters, minutes}`，minutes 含等船）= 这段步行里坐轮渡的部分（页面画成虚线）；`legs[].reason="on_water"` = 找不到路且起点或终点落在水面上，`reason_text` 写明是哪一端 |

投影顶层字段：`id, paper_no, title_en, title_zh, date, color, status, open_itinerary, together_day, sent_at, opened_at, closed_at, cancelled_at, stops, prep, contract, card, invite, quote, letter, reply, write_request`。站：`stop_id, n, kind, subtype, kind_editable, time, stay_until, arrive_at, reveal_at, place, clue, note, her_line, no_place, art_fixed, skipped, skip_reason`；未公开的内容为 `null`。`skipped`=这一站被 AI 跳过了（`date_live op=skip`，站仍在列表里），`skip_reason` 是跳过的原因（没跳过为 `null`）。

### 她的写操作

| 方法 | 路径 | 请求体 / 说明 |
|---|---|---|
| GET | `/api/dates/{id}/her` | `{marks, photos, now}`：勾选状态、照片、服务端时刻（页面按它判断「到点」） |
| POST | `/api/dates/{id}/her/mark` | `{key, on}`。`key` 白名单：`prep:<条目键>`（准备清单）、`checkin:<stop_id>`（检票，不能撤销）、`nophoto:<stop_id>`、`sleeve:<stop_id>`、`lid`、`card_torn`、`contract_fp` |
| POST | `/api/dates/{id}/her/photo` | multipart：`file`（必填）、`stop_id`、`caption`（≤24 字）、`client_id`（重发去重）、`replace`、`replace_id` |
| GET / PATCH / DELETE | `/api/dates/{id}/her/photo/{photo_id}` | 取原图 / `{caption}` 改小字 / 删除 |
| PATCH | `/api/dates/{id}/her` | `{ops:[...], expect_version?}`：结束后她的编辑。op：`set_line`、`update_stop`、`add_stop`、`remove_stop`、`set_plan`（只限她补记的约会）。一次最多 20 项，整笔原子，失败时 `detail` 带 `op_index` 与 `field` |
| PUT | `/api/dates/{id}/her/write` | `{what, text?, items?}`：`what` = `invite`（只限补记的约会）/ `contract`（写在 `items`）/ `card`。他已经写了=409 |
| PUT | `/api/dates/{id}/her/letter` | `{text}`：她的信；空串=删除 |
| POST | `/api/dates/{id}/her/request_write` | `{client_id}`：请他补写这一盒还没写的全部；没有任何 AI 待办路时 409 `no_ai_channel` |
| POST | `/api/dates/backfill` | 补记一次以前的约会：`{client_id, date, title_en, title_zh?, color, stops?, invite_text?, contract?, card?}`；`client_id` 必填，同一个值重发返回同一盒 |
| GET | `/api/dates/place_search?q=` | 地点搜索：`{items:[{title, address, lat, lng, kind, subtype, source, provider_id, region, fallback_from, coords_storable}], source, fallback_from, fallback_code, notice}`。兜底时 `notice` 是一句可直接显示的说明 |

照片：只收 JPEG / PNG / HEIC / HEIF / AVIF，按文件头判断（不信扩展名与 `Content-Type`）；单张 ≤20 MB（413）；一盒最多 60 张；当天检过票（或约会已结束）才能放；原图原样保存。

选中搜索结果写进站时，把候选的 `source` / `provider_id` 原样作为 `place_source` / `place_ref` 传回（连同 `lat` / `lng`）。`coords_storable=false` 表示在当前存储规则下这个坐标不会长期存在站上（见 README「条款提示」）。

### 网页推送

| 方法 | 路径 | 请求体 |
|---|---|---|
| POST | `/api/push/subscribe` | 浏览器的 PushSubscription（`{endpoint, keys:{p256dh, auth}}`）。没配 VAPID=503；最多 20 个设备 |
| POST | `/api/push/unsubscribe` | `{endpoint}` |

推送内容只有固定标题、`"Ephemera"`、`navigate`（落点，见 [EMBED.md](EMBED.md)）与 `event_id`。

## AI 侧 `/context`

### `GET /context`

返回纯文本（`text/plain`）：AI 待办列表 + 进行中约会的状态，供自建网关每轮接到系统提示末尾。

| 参数 | 说明 |
|---|---|
| `claim=<客户端唯一编号>` | 同时把文本里可领取的待办领给 `context:<编号>`。编号要每个客户端唯一，不要用应用名；空值=400 `client_required` |
| `format=json` | 返回 `{"text": ..., "_meta": {"ephemera/secret": true, "ephemera/reveal_after": null}}` |

响应头：`X-Ephemera-Secret: true`、`X-Ephemera-Reveal-After: none`。

### `POST /context/claim` · `/context/done` · `/context/release`

请求体：`{"ids": [待办编号, ...], "client": "<客户端唯一编号>"}`（两项都必填）。

| 路径 | 返回 |
|---|---|
| `/context/claim` | `{claimed:[...], held:{编号: 当前领取者}, closed:[...], unknown:[...], _meta}` |
| `/context/done` | `{done:[...], already:[...], held:{...}, unclaimed:[...], unknown:[...], _meta}`：只有当前领取者能确认完成 |
| `/context/release` | `{released:[...]}` |

领取 30 分钟后自动失效，待办可再被领取。

## AI 侧 `/mcp`

Streamable HTTP（有状态：每个连接一个 `mcp-session-id`，同时是领取待办时的身份）。工具与 `ephemera-date stdio` 相同。每个工具结果的 `_meta`：

| 键 | 说明 |
|---|---|
| `ephemera/secret` | 恒为 `true`：结果可能含她还不能看的内容 |
| `ephemera/reveal_after` | 从这个时刻（epoch 秒）起全部内容已对她公开（约会已结束）；`null`=还不能公开 |
| `ephemera/plan_ids` | 结果涉及的约会编号 |

## 出站 webhook

两个 webhook 都是 `POST`、`Content-Type: application/json`，带 `Idempotency-Key`；设了 `EPHEMERA_WEBHOOK_SECRET` 时带 `X-Ephemera-Signature: sha256=<hex>`（对原始请求体做 HMAC-SHA256）。超时 10 秒。

**用户事件**（`EPHEMERA_EVENT_WEBHOOK`），`Idempotency-Key: ephemera-event-<事件编号>`：

```json
{"type": "event", "kind": "envelope", "title": "你收到一封信", "body": "Ephemera · 10/28",
 "plan_id": 1, "event_id": 7, "navigate": {"page": "seal", "planId": 1}}
```

`kind`：`envelope`（寄出）、`telegram_manual` / `telegram_auto`（电报）、`cancel`、`close`、`late_written`（约会后他补写好了）。只带固定文案、约会名与日期，不带地点、线索或正文。

**AI 待办**（`EPHEMERA_AI_WEBHOOK`），`Idempotency-Key: ephemera-todo-<待办编号>`：

```json
{"type": "ai_todo", "id": 3, "kind": "reminder", "text": "…", "plan_ids": [1],
 "created_at": 1793000000.0, "_meta": {"ephemera/secret": true}}
```

`kind`：`reminder`（约会提醒）、`write_request`（她请你补写）、`memory_notice`（AI 排队写的事件卡「后续」段没写进去：排队之后卡上的「后续」被改过，卡上那段留着）。只叫醒、不领取。

投递结果判定（两个 webhook 相同）：2xx=送到；连不上、429、503=下一轮重试；发出后超时、502、504 等 5xx=结果未知，不重发；4xx=失败，不重发。
