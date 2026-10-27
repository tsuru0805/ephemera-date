# 聊天里的约会卡（参考示例）

把 Ephemera 的约会事件放进你自己的聊天界面时，可以照这份示例来做：一封信寄到时显示一只小信封，有变动时显示一张电报纸，到点提醒那一轮显示一张邮戳提醒卡；AI 写约会的那一轮，思考内容用一页封着的纸盖住，她确认之后才揭开。

这只是参考，不是网页包的一部分：`web/` 的构建、页面和测试都不引用这里。组件写在 [`ChatCards.tsx`](ChatCards.tsx) 里（React Native，也能在 React Native Web 里用）；截图在 [`screenshots/`](screenshots/)。

## 数据从哪来

两种来源，卡片用的是同一套字段：

- **读事件列表**：`GET /api/dates/events?plan={id}` 返回 `{events: [{id, plan_id, kind, text, created_at, read_at, ref_stop}]}`（`ref_stop`：`{n, title?}` 或 `null`），`plan` 可省（见 [docs/API.md](../../docs/API.md)）。读过之后用 `POST /api/dates/events/read {ids}` 标成已读。
- **收事件 webhook**：`EPHEMERA_EVENT_WEBHOOK` 收到的请求体是 `{type:"event", kind, title, body, plan_id, event_id, navigate}`。用 `eventFromWebhook(body)` 把它转成卡片要的事件，`title` 就是给她看的那句话。

卡片上还要显示约会的几个字段（`id`、`paper_no`、`title_en`、`date`），从 `GET /api/dates`（列表）或 `GET /api/dates/{id}` 里取。已经取消的约会不在列表里，要单独按 id 取。

事件里只有固定文案、约会名和日期，不带地点、线索或正文。卡片也只显示这些，不会提前把约会内容露出来。

## 每种事件的显示和去向

| `kind` | 什么时候发生 | 卡片 | 第二行 | 底部 | 点卡片去哪（`navigateFor`） |
|---|---|---|---|---|---|
| `envelope` | 他把约会寄出了 | 小信封：粉色信封、封蜡、手写体 Ephemera、`NO. 纸号`；右边写事件文字、`Ephemera · 月/日`、「拆开 ›」 | — | — | `{page: "seal", planId}`：拆信页 |
| `telegram_manual` | 他手动发来一封电报（改了时间、换了地方等） | 电报纸：TELEGRAM 抬头、时间、事件文字 | 有一封新电报 | 「约会名」、「去看看 ›」 | `{page: "telegrams", planId: null}`：电报列表 |
| `telegram_auto` | 引擎自动发的电报（路线写好了等） | 同上 | 有一封新电报 | 「约会名」 | 电报列表 |
| `telegram_auto`（跳过站） | 他跳过了某一站，或撤回了跳过 | 同上，文字如「第 3 站跳过了：原因」 | 有一封新电报 | 「约会名」 | 电报列表 |
| `cancel` | 约会取消了 | 电报纸，右上斜盖一枚 CANCELLED 章 | 有一封电报 | 「约会名」 | 电报列表 |
| `close` | 约会收进纪念盒了 | 电报纸，右上一枚纪念盒圆章 | 「约会名」 | `No. 纸号` | `{page: "box", planId}`：纪念盒 |
| `late_written` | 约会结束后，他补写好了她在等的那一样 | 电报纸 | 有一封新电报 | 「约会名」 | 纪念盒 |

几点说明：

- **跳过站的电报**：他跳过或撤回跳过某一站时，引擎发一条 `telegram_auto`，文字如「第 3 站跳过了：原因」「第 3 站不跳过了」。事件里的 `ref_stop` 是 `{n, title?}`：`n` 是第几站，`title` 是站名，只有那一站的地点已经对她公开时才带。卡片按电报显示，文字原样照搬。约会页上被跳过的站会变淡，并写「跳过了：原因」。
- **不认识的 `kind`**：一律按电报显示、去电报列表，以后引擎新增种类时卡片不会出错。
- **去向**：和引擎 webhook 的 `navigate` 相同，也和页面的 `navigate{page, planId}` 相同（见 [docs/EMBED.md](../../docs/EMBED.md)）。宿主可以把它原样发给网页包，或者打开页面时放进 `init.route`。电报列表不需要约会编号。
- **按时间排**：每条事件一张卡，按 `created_at` 插进聊天记录里对应的位置。
- **时间显示**：默认用设备的时区，显示成「月/日 时:分」。要和约会一样用引擎的时区（`EPHEMERA_TZ`），就传 `formatAt`。

### 提醒卡（AI 那一侧）

引擎到点会给 AI 发一条 `kind: "reminder"` 的待办（`EPHEMERA_AI_WEBHOOK`）。AI 醒来后说的那句话，可以用 `DateRemindCard` 显示：`head` 写主句（如「明晚七点见」），`sub` 写一行补充（如地点），`at` 写时间行，`stampDate` 写邮戳上的日期（如 `OCT 28`）。主句超过约 8 个汉字的宽度时，字号自动小一档，邮戳旁边的波浪线也会去掉。

### 封着的思考（写约会那一轮）

AI 在某一轮里写约会（调用了写约会的工具）时，那一轮的思考里会有约会的内容。聊天界面要把这一轮的思考块换成 `SealedThinking`：一页封着的纸，右下角盖一枚圆形墨章 SEALED，写着「**这一轮在写约会** · 内容保密」和「揭开看看 ›」。

- 点「揭开看看 ›」，纸上换成一句确认：「揭开会看到他写的约会内容，确定吗？」，下面是「揭开」和「先不看」。
- 点「揭开」：卡片换回原来的思考块（`renderOpen()` 画的那个），同时调一次 `onReveal`。点「先不看」：回到封着的样子。
- 确认句里的「他」用 `him` 传（默认「他」）；其余文字在 `CARD_WORDS` 里（`sealedTurn`、`sealedSecret`、`reveal`、`revealAsk`、`revealYes`、`revealNo`），可用 `words` 换。

接口：

```tsx
<SealedThinking
  sealed={turn.sealed}                 // 这一轮要不要盖：由你的后端判断；false = 直接画 renderOpen()
  onReveal={() => markOpened(turn.id)} // 她确认揭开时调一次（可选，比如记下这一轮已经揭开过）
  renderOpen={() => <ThinkingBlock turn={turn} />}   // 原来的思考块，聊天界面本来怎么画就怎么画
  him="阿远"                            // 确认句里怎么称呼他（可选）
  fonts={fonts}
/>
```

**哪一轮要盖**由后端决定，卡片只认 `sealed`。后端怎么判断（哪些工具调用算「写约会」、思考里的约会内容怎样不经由别的路径露出去）见 [docs/SECRECY.md](../../docs/SECRECY.md)。

## 在 React Native 里用

1. 装 `react-native-svg`。
2. 把 `ChatCards.tsx` 复制进你的项目。
3. 在聊天列表里渲染：

```tsx
import { DateEventCard, type NavigateTarget } from "./ChatCards";

<DateEventCard
  event={event}                       // 来自 /api/dates/events，或 eventFromWebhook(body)
  plan={briefs.get(event.plan_id)}    // { id, paper_no, title_en, date }
  fonts={{                            // 打包好的字体名；不传的那一项用系统字体
    display: "PlayfairDisplay-Black", displayBold: "PlayfairDisplay-Bold", italic: "PlayfairDisplay-BoldItalic",
    script: "PinyonScript-Regular", typewriter: "CourierPrime-Bold",
    serif: "NotoSerifSC-Regular", serifBold: "NotoSerifSC-Bold",
  }}
  onOpen={(to: NavigateTarget) => openEphemera(to)}   // 打开网页包，并把 to 作为 navigate 发过去
/>
```

`words` 可以换掉卡片上不是引擎给的那些词（「拆开 ›」「去看看 ›」「有一封新电报」等），比如做其他语言时。颜色在 `CARD_COLORS` 里，取的是页面默认皮肤「奶白底」那一组。纸品就是纸品，不跟着聊天界面的皮肤变。

打包字体时不要再写 `fontWeight`：字重是靠换字体文件来选的，再写 `fontWeight` 会让 iOS 退回系统字体。

## 在网页里用

- **React 网页**：用 React Native Web 直接渲染这个组件。网页包本身就是这样做的，示例截图也是用网页包渲染的。
- **其他技术栈**（原生 iOS/Android、Flutter、纯 HTML 等）：照着截图自己画，要点如下：
  - **信封**：176×112，粉色 `#F8D6DE`，整体逆时针转 3°，阴影偏下。两道白色斜线（透明度 0.6）拼成信封的 V 字。中间一枚 36 的封蜡，`#D92662` 底、`#FFD9E3` 的细圈和心形。左下用手写体写「Ephemera」，19 号，`#A8435F`。右侧文字区距信封 18：标题用宋体粗体 15 号 `#A8435F`，副行用斜体 12 号，链接用宋体 11.5 号 `#C15772`、点状下划线。
  - **电报**：宽 322，底色 `#FBF4EF`，阴影偏下。抬头「TELEGRAM」用粗衬线 17 号，字距 5.8，`#A8435F`，右边是打字机体 9 号的时间。抬头下面一粗一细两道线，`#634458`。正文 13.5 号、行高 21：**只要含中文就整条用宋体**，打字机字体没有中文字形，混排会忽宽忽窄。底部左边斜体写约会名，右边写「去看看 ›」。
  - **CANCELLED 章**：1.6 粗的 `#C15772` 边框，粗衬线 13 号，转 −9°，透明度 0.82，放在右上。
  - **纪念盒章**：24 齿的锯齿圆，`#C15772` 底，里面一道白色虚线圈和一颗白心，56 大小，转 8°，放在右上。
  - **封着的思考**：宽 304，底色 `#FBF4EF`，0.6 的细边框，阴影偏下；里面再一道 1 粗的 `#634458` 内框。顶上一行小号大写字「THIS TURN · SEALED」和「EPHEMERA」左右分开，下面一道细线。正文宋体 13 号、行高 21，「这一轮在写约会」用宋体粗体 `#A8435F`；「揭开看看 ›」是链接样式。确认时：宋体 12 号的确认句，下面两个方块按钮——「揭开」`#C15772` 实底白字，「先不看」`#634458` 细框。右下角压一枚 72 大的圆形墨章（双圈、环形字 THIS TURN · SEALED · EPHEMERA、中间 SEALED，`#C15772`），转 12°，透明度 0.8，下沿探出卡片 14。
  - **提醒卡**：宽 326，底色 `#F6E6E1`，细边框。头部分两栏：左边粗衬线写「Ephemera」和「A REMINDER」，右边写「约会提醒」和时间。主句用宋体粗体 25 号。右边压一枚环形字邮戳（EPHEMERA · DATE REMINDER），配四道波浪线。

## 截图

用网页包把 `ChatCards.tsx` 渲染出来，按 390 宽、2 倍像素截取；聊天背景是平的 `#F4F1EC`：

| 事件 | 截图 |
|---|---|
| `envelope` | [envelope.png](screenshots/envelope.png) |
| `telegram_manual` | [telegram_manual.png](screenshots/telegram_manual.png) |
| `telegram_auto` | [telegram_auto.png](screenshots/telegram_auto.png) |
| 跳过站的电报 | [telegram_skip.png](screenshots/telegram_skip.png) |
| `cancel` | [cancel.png](screenshots/cancel.png) |
| `close` | [close.png](screenshots/close.png) |
| `late_written` | [late_written.png](screenshots/late_written.png) |
| 提醒卡 | [reminder.png](screenshots/reminder.png) |
| 封着的思考 | [sealed_thinking.png](screenshots/sealed_thinking.png) |
| 封着的思考：确认中 | [sealed_thinking_ask.png](screenshots/sealed_thinking_ask.png) |
| 封着的思考：揭开后（这里的思考块是示意） | [sealed_thinking_open.png](screenshots/sealed_thinking_open.png) |

## 检查

`web/src/chatCardExample.test.tsx` 会渲染每一种卡，检查点击后的去向，以及封着的思考从盖着、确认到揭开的三步；它随网页包的 `npm test` 一起跑。示例的类型检查要借用 `web/node_modules` 里的类型定义，需要另写一个 tsconfig，把 `react`、`react-native`、`react-native-svg` 的类型路径指过去，再对 `ChatCards.tsx` 单独跑一次 `tsc`。
