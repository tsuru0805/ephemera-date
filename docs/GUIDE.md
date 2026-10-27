# 使用指南

给开发者的完整说明。入门与项目介绍见 [README](../README.md)。

## 技术概览

一个自托管的约会引擎：AI 通过 MCP 工具写一次约会（站、路段、准备清单、契约书、小卡、电报），引擎按时间规则把内容分阶段公开给另一方的页面，约会结束后输出事件卡与 JSON 记忆条目。

- 引擎：Python，SQLite 存储，一个进程同时提供她那侧的 HTTP 接口、AI 侧的 MCP（stdio 与 HTTP 两种）和 `GET /context`。
- 页面（网页包）：`web/`，用 Expo（React Native Web）导出的静态网页。`ephemera-date serve` 在 `/app/` 提供；可以单独在浏览器里打开（可添加到主屏幕），也可以嵌进别的 App（内嵌网页窗口 + 嵌入协议）。
- 只做中文。

版本：**0.1 预览版**。接口和数据格式在 1.0 之前可能变化。

## 页面（网页包）

源码在 `web/`（Expo SDK 54、React Native Web），导出成静态网页。

```bash
cd web
npm ci
npm test                    # 单元测试（jest）
npm run build               # → web/dist，基础路径 /app（引擎提供的就是这一份）
npm run build:demo          # → web/dist-demo，试玩构建（假数据 + 快进时钟），基础路径 /ephemera-date（GitHub Pages）
```

- `EPHEMERA_WEB_BASE` 是构建时的基础路径，默认 `/app`；`build:demo` 默认 `/ephemera-date`。放进引擎的那一份必须是 `/app`（`scripts/bundle_web.py` 会强制用 `/app` 并检查）。
- 开发时热更新：先起引擎并允许开发服务器跨源调用，再起开发服务器：

  ```bash
  EPHEMERA_ALLOWED_ORIGINS=http://localhost:8081 .venv/bin/ephemera-date serve
  cd web && EPHEMERA_WEB_BASE=/ npm start         # 打开 http://localhost:8081/ ，「后台地址」填 http://127.0.0.1:8791
  ```

  开发服务器要用 `EPHEMERA_WEB_BASE=/`：默认的 `/app` 下开发服务器取不到 `canvaskit.wasm` 与 `sw.js`，画面上用 Skia 画的部分出不来。
- 不起开发服务器、看构建结果：`node scripts/serve.mjs dist --port 18790 --engine http://127.0.0.1:8791`（在 `web/` 里跑），打开 <http://127.0.0.1:18790/app/>；`/api` 等请求转给引擎，同源，不用设跨源。
- 任何一份页面地址加 `?demo=1` 进试玩（同一个标签页里一直留在试玩，`?demo=0` 退出）；不连引擎、不要口令。
- 嵌进网页：[web/examples/iframe-host.html](../web/examples/iframe-host.html) 是一个最小的宿主页，演示握手、`navigate`、返回到底关窗、前后台、键盘、安全区、退出与选图。本机试：

  ```bash
  EPHEMERA_EMBED_ORIGINS=http://127.0.0.1:18792 .venv/bin/ephemera-date serve
  cd web && node scripts/serve.mjs examples --port 18792 --base /ex
  # 打开 http://127.0.0.1:18792/ex/iframe-host.html?page=http://127.0.0.1:8791/app/&api=http://127.0.0.1:8791
  # 在右边填口令，点 reopen
  ```

  宿主页会自动在页面地址上加 `?host=<宿主来源>`。自己写宿主时也必须带它（Firefox 没有 `location.ancestorOrigins`，不带的话页面认不出宿主，连 `ready` 都不发）。引擎默认只允许同源嵌入（`frame-ancestors 'self'`），别的来源要列进 `EPHEMERA_EMBED_ORIGINS`。
- 嵌进原生 App：页面经 `window.webkit.messageHandlers.ephemera`（iOS）/ `window.ReactNativeWebView` / `window.EphemeraHost`（Android）发消息给宿主，宿主调用 `window.ephemera.receive(消息)` 回给页面；桥来不及在页面加载前注入时，地址加 `?embed=native`。完整协议见 [docs/EMBED.md](EMBED.md)。
- `/app/` 的缓存与安全头（CSP 等）见 [docs/API.md](API.md)「页面 `/app/`」。

## 接 AI

AI 用 9 件 MCP 工具：`date_open` 开约会、`date_view` 查看、`date_route` 查步行时间、`date_edit` 写站与路段、`date_send` 寄出、`date_live` 当天操作、`date_close` 结束、`date_inbox` 待办、`date_memory` 查已结束的约会。

**本机 MCP 客户端（stdio）**，以 Claude Code 为例：

```bash
claude mcp add ephemera -e EPHEMERA_TZ=Asia/Shanghai -e EPHEMERA_AI_CHANNELS=pull -- /path/to/.venv/bin/ephemera-date stdio
```

- `ephemera-date stdio` 只读写数据库，**不跑调度**。到点提醒、事件推送、事件卡与 JSON 输出只在 `ephemera-date serve` 里跑——页面本来也要连 `serve`，所以通常两者同时运行、共用同一个 `EPHEMERA_DATA_DIR`。
- 只用 stdio、没设 `EPHEMERA_AI_TOKEN` 时，要设 `EPHEMERA_AI_CHANNELS=pull`，否则引擎认为没有任何一条路能把待办送到 AI，页面上「请他补写」的入口不出现。`serve` 那一侧也要设同样的值。

**HTTP MCP**：`ephemera-date serve` 的 `http://<host>:8791/mcp`（Streamable HTTP），请求头带 `Authorization: Bearer <EPHEMERA_AI_TOKEN>`。

**claude.ai 网页的连接器**需要公网 HTTPS 地址（VPS 加反向代理，或本机加隧道），连接器里填不了自定义请求头，所以口令写在地址里：`https://<你的域名>/mcp?key=<EPHEMERA_AI_TOKEN>`。**这一条本版没有实测。**

- 风险：写在 URL 里的口令可能留在反向代理、隧道服务的访问日志和浏览器历史里。能设请求头的客户端请一律用 `Authorization` 头。引擎自己的日志（含 uvicorn 访问日志）会把 `key=` 后面的值打成 `***`，但管不到引擎之外的代理。
- 口令泄露后换一个新的 `EPHEMERA_AI_TOKEN` 并重启服务，旧地址立即失效。
- `?key=` 只对 AI 侧（`/mcp`、`/context`、`/context/*`）有效；她那侧 `/api/*` 只认请求头。

### 最小示例：写一场约会

下面是一串工具调用（工具名 + 参数），从开约会到结束。站与路段的编号用 `date_view` 详情里标的 `[stop N]`。

```text
date_open  {"title_en": "A Quiet\nRiver Walk", "date": "2026-10-28", "color": "sky"}          → 开好了：约会 #1
date_edit  {"plan": 1, "op": "add_stop", "kind": "cafe", "time": "15:00", "title": "转角咖啡",
            "address": "滨河路 18 号", "clue": "门口有一棵银杏", "reveal_at": "12:00"}
date_edit  {"plan": 1, "op": "add_stop", "kind": "walk", "time": "16:30", "title": "沿河步道",
            "address": "河堤", "clue": "把今天走完"}
date_edit  {"plan": 1, "op": "set_prep", "items": [{"section": "wear", "text": "一双走得久的鞋"},
                                                   {"section": "bring", "text": "一件薄外套"}]}
date_send  {"plan": 1}
# 约会当天
date_view  {"plan": 1}                                    → 详情里第 2 站标着 [stop 2]
date_live  {"plan": 1, "op": "open_stop", "stop_id": 2}
date_close {"plan": 1, "quote": "Good company, a good day"}
```

- `op` 的可选值、`color`、`kind`、路段的 `mode` 与 `source`、准备清单的 `section` 都在工具的 JSON Schema 里列为 `enum`。
- `set_prep` 的 `items` 每一条是 `{section, text, detail?}`，`section` 是 `book`（提前准备）/ `wear`（穿什么）/ `bring`（带什么）/ `weather`（天气）。寄出前准备清单不能是空的。
- **第 1 站必须写 `reveal_at`**（地点公开时间，要早于到达）。第 2 站起不写时有默认：通往这一站的路段写了出发时刻就用出发时刻，写了分钟数就用「到达 − 分钟数」，都没写就是到达时刻。第 1 站前面没有路段可推，默认只能是到达时刻，而地点要早于到达公开，所以没有可用的默认：详情里第 1 站没写时显示「（没写）」，`date_send` 会列出「第 1 站没写地点公开时间」并拒绝寄出。
- `date_live` 的 `op=skip`（`stop_id` + `reason`，原因必写、≤60 字）跳过一站，她看到过的也行：这一站留在记录里标「跳过了」，不再参与时间先后、路段和提醒，后面的站可以用 `op=shift` 往前挪；通往它和从它出发的路段一并撤掉，并自动发一封电报说明。`op=unskip` 撤回。寄出后删站、挪站让路段断了时，断的那段由引擎撤掉，不再拒绝这次修改。
- `date_live` 的 `op=open_stop` 只是提前公开这一站的内容：地点马上可见，「到站给她的话」在约会当天提前开时一起可见。检票仍要等到这一站设定的时间，放照片要先检票，所以检票与放照片照旧按该站的时间解锁。

## AI 待办：三条路

MCP 客户端里的 AI 没法被外部叫醒。到点的约会提醒、她请他补写的东西，都放进同一张待办表，有三条路取：

1. **拉**：每件约会工具的回执末尾写着「约会待办 N 件」；`date_inbox` 列出（`op=list`）、领取（`op=claim`）、确认完成（`op=done`）、放回（`op=release`）。
2. **注入**：`GET /context`（AI 口令）返回一段纯文本：待办 + 进行中约会的状态，供自建网关每轮接到系统提示末尾。`?claim=<客户端唯一编号>` 同时领取文本里可领取的待办；`?format=json` 返回 `{text, _meta}`。不讲 MCP 的网关用 `POST /context/claim`、`/context/done`、`/context/release`。详见 [docs/API.md](API.md)。
3. **推**：设 `EPHEMERA_AI_WEBHOOK`，每件新的、没人领的待办 POST 一次给你自己的网关，由它去叫醒 AI。

规则：

- **看到不等于领取。** 任何一条路都能显示待办；要处理必须先领取。领取是排他的（30 分钟内别的连接领不走，过时自动放回），只有领取者能确认完成。
- 领取者按「一次连接」认：MCP over HTTP 用该连接的 `mcp-session-id`，stdio 每个进程一个随机编号，`/context` 用调用方自己传的唯一编号（不要用应用名）。
- webhook 只负责叫醒，不领取；被叫醒的一方照样要先领取成功再动手。
- **去重**：每次 webhook 请求带 `Idempotency-Key: ephemera-todo-<待办编号>`，同一件待办重发时这个值不变，接收方按它丢弃重复。设了 `EPHEMERA_WEBHOOK_SECRET` 时另带 `X-Ephemera-Signature: sha256=<请求体的 HMAC-SHA256 十六进制>`。
- 投递结果：2xx=送到；连不上、429、503=下一轮重试；发出后超时、502、504 及其他 5xx=结果未知，不重发；4xx=失败，不重发。创建超过 24 小时还没送出的放弃推送（待办本身仍在，拉和注入照常能看到）。
- `EPHEMERA_QUIET_HOURS=23:00-08:00` 这类设置只推迟 webhook，不影响拉与注入。
- 三条路一条都没配好时，页面不显示「请他补写」入口，接口也拒收这个请求。

## 保密在 AI 一侧

约会内容在公开时间到之前不该让她看到。引擎这侧能保证的：

- 她那侧的页面接口只返回按时间规则投影后的内容；还没公开的站、地点、线索不出现在任何 `/api/*` 响应里（含地图与错误响应）。构思中的约会对她只显示进度，名字和内容都不显示。
- 用户事件 webhook（`EPHEMERA_EVENT_WEBHOOK`）只带固定文案、约会名与日期、页面落点，不带地点、线索或正文。网页推送只带固定标题、「Ephemera」和落点，连约会名都不带。

引擎**做不到**的：AI 写约会的那段对话本身。工具回执里就有完整行程，任何能看到那段对话的人都能看到。为此：

- 每个工具结果的 MCP `_meta` 带机器可读标记：`ephemera/secret: true`、`ephemera/reveal_after`（从这个时刻起全部内容已对她公开，epoch 秒；`null`=还不能公开）、`ephemera/plan_ids`。`GET /context` 带 `X-Ephemera-Secret: true` 与 `X-Ephemera-Reveal-After` 响应头（JSON 格式时另带 `_meta`）；AI 待办 webhook 的请求体带 `_meta: {"ephemera/secret": true}`。
- 这些标记只有在你自己的网关或前端读取并据此遮住内容时才起作用；现成的 MCP 客户端一般会忽略它们。
- 建议写约会的一方**单独开一个对话**写约会，不要在她也会看的对话里调用约会工具。

## 地图与地点服务

### 底图（本地，不调外部地图服务）

地图与步行时间都用本地底图库：从 OpenStreetMap 区域包裁出一个城市建成 SQLite。

```bash
.venv/bin/pip install '.[map-build]'      # pyosmium + pyshp
# 已有区域包（从 https://download.geofabrik.de/ 下载），按范围裁剪；bbox = 最小经度,最小纬度,最大经度,最大纬度
.venv/bin/python scripts/build_basemap.py --pbf monaco-latest.osm.pbf --bbox 7.41,43.72,7.44,43.75
# 让脚本从 Geofabrik 下载区域包（只下一次，已下载就复用），并用 Nominatim 查一次城市范围
.venv/bin/python scripts/build_basemap.py --region europe/monaco --city "Monaco" --workdir /tmp/osm
```

- 默认输出到 `EPHEMERA_MAP_DIR`（默认 `<数据目录>/maps`）；那里的每个 `*.sqlite` 是一个城市，地图与步行按覆盖范围自动选用，新建的库下一次请求就生效。
- 可选 `--sea water_polygons.shp` 补海面（OSM 的海是海岸线，要从 <https://osmdata.openstreetmap.de/> 的 water-polygons-split-4326 里取）。
- 范围外默认留 2 公里缓冲带防边界截断（`--buffer-m`）；`--max-nodes` / `--max-kept` / `--max-memory-mb` 是规模上限，超了报错。
- 步行时间 = 本地路网最短路 + 步行速度（默认 4.5 km/h，`EPHEMERA_WALK_SPEED_KMH`）。路网找不到连通路径、或地点不在任何底图范围内时，明确回答「查不了」及原因，**不拿直线距离冒充**。
- 找不到路、而且起点或终点落在水面/海面里时，原因会写明是哪一端在水面上（常见原因是坐标偏了，例如把国内地图的 GCJ-02 坐标当成了 GPS 坐标）。
- 建底图时会收进轮渡航线（`route=ferry` 的路与轮渡航线关系的成员路），步行可以坐轮渡过江过海。轮渡不按步行速度算：每段 = 公里数 × `EPHEMERA_FERRY_MIN_PER_KM`（默认 4 分钟/公里）+ 等船 `EPHEMERA_FERRY_WAIT_MIN`（默认 10 分钟）；只有比走路快时才坐船。结果里写明含轮渡（AI 回执、地图接口 `legs[].has_ferry` 与 `legs[].ferry`、地图层 `layers.ferry`）。船期与停航引擎不知道，按实际核对。旧底图库没有轮渡，重建一次才有。
- OSM 在国内小地方的地名与路网都可能缺。
- 底图库属 ODbL 1.0，使用时必须署名「© OpenStreetMap contributors」。本仓不分发完整库。见 [LICENSING.md](LICENSING.md)。

### 地点搜索：三家服务

| 服务 | 设置 | 说明 |
|---|---|---|
| OpenStreetMap（默认） | 不设，或 `EPHEMERA_PLACES_PROVIDER=osm` | 免费、不用钥匙，默认用公共 Nominatim；可改成自建 Nominatim 或 Photon（`EPHEMERA_NOMINATIM_URL`、`EPHEMERA_OSM_FLAVOR`） |
| 谷歌（可选） | `EPHEMERA_PLACES_PROVIDER=google`，`EPHEMERA_GOOGLE_MAPS_KEY` | Places API (New) / Geocoding / Routes；按次计费，费用由钥匙持有人承担 |
| 高德（可选） | `EPHEMERA_PLACES_PROVIDER=amap`，`EPHEMERA_AMAP_KEY` | Web 服务钥匙；坐标在入库前由 GCJ-02 换算回 WGS-84，境外坐标不换 |

- **默认用 OpenStreetMap**（公共 Nominatim）：`EPHEMERA_PLACES_PROVIDER` 不设就是 `osm`，不用钥匙；只在点「搜索」时查，不边输边搜。
- 谷歌、高德是可选项，由使用者自己开启（设 `EPHEMERA_PLACES_PROVIDER=google` 或 `amap` 并配钥匙）。开启前请先读下面的「条款提示」：本工具存坐标、画在 OSM 底图上的做法与两家的通用条款冲突。
- 开了谷歌或高德后，它用不了（没配钥匙、钥匙无效、限额、超时、连不上、服务出错）时默认改用 OSM 兜底（`EPHEMERA_PLACES_FALLBACK=osm`，设 `none` 关掉）；每次兜底都在结果里写明，不悄悄换成别家的结果。默认的 OSM 本身没有兜底。
- 用公共 Nominatim 时按它的使用政策：整个应用每秒最多 1 次（跨进程排队）、只在点「搜索」时查（不边输边搜）、同一查询本地缓存（默认 30 天）、带能识别你实例的 User-Agent（请设 `EPHEMERA_NOMINATIM_UA`）。量大时请自建 Nominatim 或 Photon。
- 关掉地点搜索：`EPHEMERA_PLACES_PROVIDER=none`。之后搜索接口回 503 和一句可直接显示的说明，地址可以手写。
- 写错服务名（不是 `google` / `amap` / `osm` / `none`）时服务照常启动、启动日志里有一行警告，搜索接口回 503（`code=bad_config`）说明哪里写错；不会回 500。

### 条款提示

本工具的做法是把搜到的地点坐标**长期存进约会**，并**画在自己的 OSM 纸质地图上**。在谷歌与高德的通用条款下（未另获授权时），这两点都有冲突：

- 谷歌 Places 政策：Places 结果显示在地图上时必须是 Google 地图；内容不许预取、缓存、存储，例外是地点 ID 可以长期存，经纬度最多临时缓存 30 个连续日历日。
- 高德服务协议：3.5 不得直接存储、缓存本服务内部数据；4.12.4 不能脱离本服务单独使用或展示相关内容。
- OSM（Nominatim）允许存与画，条件是署名与上面的使用政策。

`EPHEMERA_PLACES_STORE_POLICY` 决定谷歌/高德的结果怎么存，默认 `terms`：

| 值 | 行为 |
|---|---|
| `terms` | 只存条款允许长期存的：谷歌只长期存地点 ID，坐标最多缓存 30 天，过期后打开地图时按 ID 重新查一次；高德不存坐标，这一站不画在地图上。从 `user` 切回 `terms` 时，已存的坐标在启动时与每一轮调度里收回。`terms` 只管存储，**不解决**谷歌「Places 结果须显示在 Google 地图上」这一条。 |
| `user` | 坐标像手写的一样长期存、照常画在 OSM 地图上。条款责任由部署者自己承担。 |

手写的地点（不经搜索）与 OSM 的结果不受这条限制。

## 约会记忆

约会结束后，引擎在 `ephemera-date serve` 的调度里输出两样东西，各自设了目录才输出：

- **事件卡**（`EPHEMERA_CARDS_DIR`）：[lorecards](https://github.com/tsuru0805/lorecards-mcp) 格式，一次约会一张，放在 vault 的 `events/` 目录（YAML frontmatter + `## 分段`）。不装 lorecards 也能直接读这个 Markdown 文件。卡的「后续」段由 AI 用 `date_memory op=followup` 写，重写时保留；手加的关键词与其他 frontmatter 保留；约会改名或改日子=卡改名，不留两张；手动删掉或归档的卡不再生成。
- **JSON 记忆条目**（`EPHEMERA_MEMORY_EXPORT_DIR`）：每次约会一个 `date-<编号>.json`，schema `ephemera.date-memory/1`，内容变化时原地重写并递增 `version`；约会被删除时文件一并删除。

AI 用 `date_memory` 按约会名、地点、日期查**已结束**的约会（进行中与构思中的不在这里）。

完整规则与字段：[docs/MEMORY.md](MEMORY.md)。

## 配置一览

全部是环境变量，在调用时读取。

**基本**

| 变量 | 默认 | 说明 |
|---|---|---|
| `EPHEMERA_DATA_DIR` | 用户数据目录（见上） | 数据库 `ephemera.db`、照片 `photos/`、生成的画 `art/`、地点缓存、底图默认目录 |
| `EPHEMERA_TZ` | `$TZ`，再是系统时区，都没有则 `UTC` | IANA 时区名，约会日期与时刻按它算 |
| `EPHEMERA_TOGETHER_SINCE` | 不设=不显示 | `YYYY-MM-DD`，「在一起第 N 天」的第 1 天 |
| `EPHEMERA_HIM` / `EPHEMERA_HER` | `他` / `她` | 引擎写出的所有文字里对两个人的称呼：工具说明与回执、报错、约会账、待办与 `/context`、推送标题、事件卡与记忆。只换称呼，句子其余部分不变；AI 和她自己写的内容不动 |
| `EPHEMERA_HIM_EN` / `EPHEMERA_HER_EN` | `Him` / `Her` | 页面上英文句子里的称呼（如信上的「Dear …,」）。引擎只把它放进 `/api/config`（`him_en` / `her_en`），自己写的中文不用它 |

**口令与出口**

| 变量 | 默认 | 说明 |
|---|---|---|
| `EPHEMERA_HER_TOKEN` | 不设=只接受本机 | 页面 / 宿主 App 的口令（`/api/*`） |
| `EPHEMERA_AI_TOKEN` | 不设=只接受本机 | AI 侧的口令（`/mcp`、`/context`）；必须与上面不同。除请求头外也认 `?key=`（风险见「接 AI」） |
| `EPHEMERA_ALLOWED_ORIGINS` | 不设=不发 CORS 头 | 允许从浏览器跨源调用的页面来源，逗号分隔，例如 `https://app.example.com,https://b.example:8443`；只对列出的来源回 `Access-Control-Allow-Origin`，不接受 `*`。见 [docs/EMBED.md](EMBED.md) |
| `EPHEMERA_EVENT_WEBHOOK` | — | 用户事件（信封、电报、取消、结束、补写好了）POST 到这里 |
| `EPHEMERA_AI_WEBHOOK` | — | AI 待办 POST 到这里 |
| `EPHEMERA_WEBHOOK_SECRET` | — | 两个 webhook 的 HMAC-SHA256 签名密钥 |
| `EPHEMERA_AI_CHANNELS` | 设了 AI 口令=`pull,context`；`EPHEMERA_AI_WEBHOOK` 是合法 http(s) 地址时加 `webhook` | 显式列出配好的待办路：`pull,context,webhook` 的子集，或 `none` |
| `EPHEMERA_QUIET_HOURS` | — | `HH:MM-HH:MM`，这段时间内 AI webhook 延后（可跨午夜） |
| `EPHEMERA_VAPID_PRIVATE_KEY` / `EPHEMERA_VAPID_PUBLIC_KEY` / `EPHEMERA_VAPID_SUBJECT` | 不设=没有网页推送 | 页面单独打开时的网页推送；`ephemera-date vapid-keys` 生成一对密钥，SUBJECT 填 `mailto:你的邮箱` |
| `EPHEMERA_SCHEDULER_TICK_S` | `30` | 调度一轮的间隔（秒） |

**页面**

| 变量 | 默认 | 说明 |
|---|---|---|
| `EPHEMERA_WEB_DIR` | 包里的 `ephemera_date/web/` | `/app/` 提供的网页包目录（构建好的 `web/dist`） |
| `EPHEMERA_EMBED_ORIGINS` | 不设=只允许同源嵌入 | 允许用 `<iframe>` 嵌入页面的宿主来源，逗号分隔（CSP `frame-ancestors`）；不接受 `*` |
| `EPHEMERA_WEB_CONNECT_SRC` | 不设=页面只连本引擎 | 页面还要连的其他引擎来源，逗号分隔（CSP `connect-src`）。与 `EPHEMERA_ALLOWED_ORIGINS` 方向相反，见 [docs/API.md](API.md)「页面 `/app/`」 |

**可替换的适配器**（值为 `模块:属性`，属性是适配器本身或无参工厂；`none`=关掉；接口见 `src/ephemera_date/ports.py`。写错——导入不了、没有这个属性、工厂出错、对象不是这个端口的适配器——时对应接口回 503（`code=bad_config`）和一句说明，不回 500）

| 变量 | 默认 | 说明 |
|---|---|---|
| `EPHEMERA_PLACES_ADAPTER` | 不设=内置三家（按 `EPHEMERA_PLACES_PROVIDER` 选） | 换掉整个地点搜索与地址转坐标。只是选内置的哪一家，用 `EPHEMERA_PLACES_PROVIDER` |
| `EPHEMERA_WALK_ADAPTER` | 本地路网 | 步行分钟数 |
| `EPHEMERA_MAP_ADAPTER` | 本地底图 | 约会地图 |
| `EPHEMERA_ART_ADAPTER` | 不设=每站用固定画轮换 | 每站现画的生成接口（不内置任何付费服务） |
| `EPHEMERA_ART_DAILY_MAX` | `10` | 每天最多开始几次生成（重试也算） |
| `EPHEMERA_ART_TIMEOUT_S` | `180` | 一次生成最长等多久（秒） |

旧变量名 `EPHEMERA_PLACE_PROVIDER` / `EPHEMERA_WALK_ROUTER` / `EPHEMERA_MAP_RENDERER` / `EPHEMERA_ART_GENERATOR` 仍然读，分别当作上面四个新名字，启动日志里每个都有一行警告；新旧都设时用新的。

**地点服务**

| 变量 | 默认 | 说明 |
|---|---|---|
| `EPHEMERA_PLACES_PROVIDER` | `osm` | 用哪家：`osm` / `google` / `amap`，`none`=关掉地点搜索。谷歌、高德开启前先读「条款提示」 |
| `EPHEMERA_PLACES_FALLBACK` | `osm` | 开了谷歌或高德时，它用不了的兜底：`osm` / `none`（默认的 OSM 本身没有兜底） |
| `EPHEMERA_PLACES_LANG` | `zh-CN` | 结果语言 |
| `EPHEMERA_PLACES_CACHE` | `<数据目录>/places_cache.sqlite` | 地点查询缓存（只有 OSM 结果进缓存） |
| `EPHEMERA_PLACES_STORE_POLICY` | `terms` | `terms` / `user`，见「条款提示」 |
| `EPHEMERA_GOOGLE_MAPS_KEY` | — | 谷歌钥匙 |
| `EPHEMERA_GOOGLE_REGION` | — | 谷歌 regionCode |
| `EPHEMERA_AMAP_KEY` | — | 高德 Web 服务钥匙 |
| `EPHEMERA_AMAP_CITY` | — | 高德搜索默认城市（城市名 / adcode / citycode） |
| `EPHEMERA_GCJ_REGIONS` | `mainland` | 哪些地区的高德坐标按 GCJ-02 换算：`mainland,hk,mo,tw` 的子集（港澳台默认不换；高德在这些地区是否加偏未经实测） |
| `EPHEMERA_NOMINATIM_URL` | `https://nominatim.openstreetmap.org` | OSM 搜索端点 |
| `EPHEMERA_OSM_FLAVOR` | `nominatim` | `nominatim` / `photon` |
| `EPHEMERA_NOMINATIM_UA` | `ephemera-date/0.1 (self-hosted; …)` | User-Agent，请改成能识别你实例的 |
| `EPHEMERA_NOMINATIM_EMAIL` | — | 附在请求里的联系邮箱 |
| `EPHEMERA_OSM_CACHE_DAYS` | `30` | OSM 查询缓存保留天数 |

**地图与记忆**

| 变量 | 默认 | 说明 |
|---|---|---|
| `EPHEMERA_MAP_DIR` | `<数据目录>/maps` | 底图库目录 |
| `EPHEMERA_WALK_SPEED_KMH` | `4.5` | 步行速度 |
| `EPHEMERA_FERRY_MIN_PER_KM` | `4` | 轮渡坐船时间，每公里几分钟 |
| `EPHEMERA_FERRY_WAIT_MIN` | `10` | 每坐一段轮渡另算的等船分钟数（可以是 0） |
| `EPHEMERA_CARDS_DIR` | 不设=不出事件卡 | lorecards vault 根目录 |
| `EPHEMERA_MEMORY_EXPORT_DIR` | 不设=不出 JSON | JSON 记忆条目目录 |

## 测过 / 没测过

**测过**（2026-10-24，macOS，Python 3.14，Node.js 25）

- 引擎自动测试 987 条全部通过，其中事件卡测试调用真实的 lorecards 命令行读取产出的卡。覆盖：保密投影（含照片、地图、事件、错误响应）、公开规则、路段时间、提醒、AI 待办三条路的领取与去重、一个 stdio 写入进程加两个 serve 进程时只投递一次、照片格式判定、高德坐标换算（国内多个控制点 + 境外不换 + 误差）、建底图全链路（合成的 OSM 数据，含轮渡过江与起点/终点在水面上）、称呼可配置（改称呼时只换称呼、默认与原句逐字一致；英文称呼单独配置）、事件卡改名/手加关键词/手删/重复导出/并发写入、`/app/` 页面托管（跳转、单页回落、走不出目录（含指向目录外的 `index.html`）、类型、缓存头与弱 ETag、安全头（含跳转与 405）、目录名大小写、来源列表解析、没构建时 503、静态文件不要口令而 `/api` 仍要）、打包时的页面检查（没有 Node 时失败并说明、`EPHEMERA_BUILD_WITHOUT_WEB=1` 才出不含页面的包、文件名不带内容指纹时失败）。
- 打包：`python -m build` 从干净状态（没有已构建的页面）先出 sdist、再从 sdist 出 wheel，安装时自动构建页面，wheel 里含页面 198 个文件（`ephemera_date/web/index.html`、`_expo/`、`assets/`、`sw.js`、`canvaskit.wasm`）；新建虚拟环境 `pip install .` 后 `ephemera-date serve` 在 `/app/` 正常提供页面；去掉 Node 时打包失败并说明原因；设 `EPHEMERA_BUILD_WITHOUT_WEB=1` 时出不含页面的 wheel，`_build.json` 记 `web: false`，启动日志有一行说明，`/app/` 回 503。
- AI 经 MCP 从头写完一场约会，走完寄出到收进纪念盒的全程：用 MCP Python 客户端经 stdio（`ephemera-date stdio`）调用工具测的，由一个只照本 README 操作的新用户走通。README「最小示例」的调用序列另有自动测试原样跑通。
- 页面：jest 单元测试 346 条全部通过（页面行为、嵌入协议、网页适配件）。Playwright 端到端（Chromium，390×844 与 768×1024，录屏）5 场：试玩从信封走到纪念盒（两种尺寸）；单独打开连真实引擎，AI 经 MCP 写好寄出、她登录、拆信、逐站签到、放照片、AI 结束、收进纪念盒（两种尺寸）；另一个来源的 iframe 宿主（`web/examples/iframe-host.html`）里握手、`navigate`、返回到底关窗、找不到的约会落回首页、前后台/键盘/安全区回包、宿主取消选图。
- `ephemera-date serve` 直接提供页面：构建后由引擎在 `/app/` 提供，浏览器登录看到首页、刷新后仍正常，CSP 下没有违规与报错；另一个来源的 iframe 宿主在设了 `EPHEMERA_EMBED_ORIGINS` 时能嵌入并完成握手，不设时浏览器按 `frame-ancestors` 拦下。开发服务器（`EPHEMERA_WEB_BASE=/ npm start`）跨源连引擎登录看到首页。
- 本 README 里的命令：`pip install .`、`ephemera-date serve`（本机，与带两个口令两种）、`curl /api/config`、口令分侧（不带口令、URL 里带口令、用对方的口令都是 401；两个口令相同时拒绝启动）、`ephemera-date stdio` 与 HTTP `/mcp` 各列出 9 件工具并调用成功、`GET /context`、`POST /context/claim`、`ephemera-date vapid-keys`、不设口令监听 `0.0.0.0` 被拒、`docker build` 与 `docker run`（容器内监听 0.0.0.0，`/api/config` 正常，经 MCP 开一个约会后重启容器数据仍在，容器里建底图后 `map_status.ready=true`）（这一条是改名为 ephemera-date 之前测的；改名后、以及加入页面构建阶段后都没有重跑 Docker）、`build_basemap.py --pbf … --bbox …`（摩纳哥；上海黄浦区约 10 秒、峰值内存约 220 MB）、在建好的底图上用 `date_route` 查步行时间、地点不在任何底图范围内时明确报「查不了」。上海黄浦区重建底图后（收进 9 条轮渡航线），人民广场到浦东（31.2397, 121.4990）步行经东金线轮渡走通，约 51 分钟、3.7 公里（其中坐船加等船 15 分钟）；不收轮渡时这段路网不连通。

**没测过**

- 页面在真手机上：真软键盘弹起时的让位、真机倾斜时的烫金光泽、网页推送真正送到手机、添加到主屏幕。
- Safari 浏览器（Playwright 端到端只用 Chromium 跑过；iOS `WKWebView` 只经 SwiftUI 宿主示例在 iOS 模拟器里跑过，见 [examples/swiftui-host](../examples/swiftui-host/)）、安卓（浏览器与 `WebView`）。
- 原生 App 宿主在真机上走完整场约会（SwiftUI 示例只在模拟器里跑过）；安卓宿主。
- 在线试玩的公开地址（GitHub Pages）。
- 带页面构建阶段的新 Dockerfile（`docker build` 没有跑）。
- AI 在 claude.ai、Claude Desktop 等真实 MCP 客户端里从头写完一场约会（只用 MCP Python 客户端经 stdio 测过，见「测过」）。
- claude.ai 连接器。
- 谷歌、高德的真实调用（要钥匙；谷歌按次计费）。
- webhook 发到真实的自建网关（测试里用的是模拟接收方）。
- Python 3.10–3.13（只在 CI 里跑）、Linux 与 Windows 本机运行、安卓。
