# 约会记忆

源码：`src/ephemera_date/memory.py`。约会结束（`date_close`）后输出两样东西，各自设了目录才输出：

| 输出 | 环境变量 | 文件 |
|---|---|---|
| lorecards 事件卡 | `EPHEMERA_CARDS_DIR`（lorecards vault 根目录） | `<vault>/events/约会·<日期>·<约会名>.md` |
| JSON 记忆条目 | `EPHEMERA_MEMORY_EXPORT_DIR` | `<目录>/date-<约会编号>.json` |

两样都只由 `ephemera-date serve` 的调度写（持有调度租约时才写，每次落盘前再确认一次）。`ephemera-date stdio` 从不写卡和 JSON；在 stdio 里调用 `date_memory op=followup` 只把文字排进数据库，由调度写进卡里。

## 事件卡

格式是 [lorecards](https://github.com/tsuru0805/lorecards-mcp) 的 event 卡：YAML frontmatter + `## 分段` 的纯 Markdown，不装 lorecards 也能直接读。

示例（虚构数据）：

```markdown
---
kind: event
title: 约会·2026-10-28·Evening Walk
keywords: [Evening Walk, 梧桐站, 河边咖啡, 10月28日]
---
## when
2026-10-28（周三）
各站时刻：19:00、19:30

## who
她、他

## what
- 19:00 · 梧桐站 · 集合
  线索：出站口右手边
- 19:30 · 河边咖啡 · 咖啡
  线索：河边的小门
  备注：点你想喝的
那一句话：那天很好

## stance

## followup
```

### 分段

段名与目录跟随 vault 的 schema（`kinds.yaml`）；默认是 `events/` 与 `when / who / what / stance / followup`。

| 段 | 内容 |
|---|---|
| `when` | 日期（星期）；设了 `EPHEMERA_TOGETHER_SINCE` 时加「在一起的第 N 天」；有中文名时加全名；各站时刻 |
| `who` | `<她>、<他>`（`EPHEMERA_HER` / `EPHEMERA_HIM`） |
| `what` | 每站：时刻 · 地点名 · 类别，及线索、备注；那一句话；他的回信 |
| `stance` | 她在各站写的一句话、照片小字、她的信 |
| `followup`（「后续」） | 由 AI 写：`date_memory op=followup plan=<编号> text=<内容>`（≤600 字，整段替换）；或任何 lorecards 写入方。引擎生成卡时不写这一段 |

后续段取 vault schema 的 `recent_section.event`；schema 的段数与默认不同时：多出的段原样保留不写；少于四段时，放不下的字段以「名称：」小标题并进承载 `what` 的那一段。

### 规则

- **关键词**：约会英文名、中文名、每个站名（2 个字及以上）、「M月D日」。通用词（「约会」、lorecards 的通用词表、vault 的 `generic_keywords`）不进关键词。
- **重写时保留**：「后续」段的现有内容；手加的关键词；别名及其他所有 frontmatter 键；schema 以外的标题；第一个标题之前的文字。
- **后续段冲突**：AI 排队的后续与卡上被改过的后续，较新的胜出（卡上那段没被人动过时，排队的直接写入）。排队的那段输掉时不会静默丢弃：AI 待办里会出现一条 `memory_notice`，写明排队的原文。
- **卡名**：`约会·<日期>·<全名>`。磁盘上已有同名文件但不是这次约会的卡（手写的、别的约会的）时，绝不覆盖，改用 `…·<约会编号>`，再不行用 `…·<约会编号>·n`。
- **改名**：约会改名或改日子=卡改名（以旧文件为保留内容的来源，写好新文件后删除旧文件），不会出现两张卡。
- **不复活**：本模块写过的卡被删除，或被归档进 lorecards 的 `_archive/`，不再生成。
- **frontmatter 读不出来**的卡不改写（修好后下一轮再写）。
- **并发**：读卡时记下版本（mtime_ns + 大小 + inode）→ 生成 → 落盘前复核版本 → 原子落盘（原地用 `os.replace`；新文件名用 `os.link`，不会覆盖任何文件）。中途被改或被删=这一轮放弃，下一轮重读。整个过程持有 vault 根目录下的跨进程锁文件 `.ephemera-cards.lock`（POSIX；Windows 上只在进程内互斥）。
- **权限**：新文件按通常的 `0666 & ~umask`；改写保留原文件的权限。
- 第一次写出卡时，AI 的约会账里多一项「写这张卡的后续」；后续不为空后这一项完成。

## JSON 记忆条目

每次结束的约会一个文件 `date-<约会编号>.json`，UTF-8，缩进 2。内容变化时原地重写（临时文件 + `os.replace`）并把 `version` 加 1；约会被删除时，本模块写过的文件一并删除。

### schema `ephemera.date-memory/1`

| 字段 | 类型 | 说明 |
|---|---|---|
| `schema` | string | 恒为 `"ephemera.date-memory/1"` |
| `version` | int | 本文件内容的版本，从 1 起，每次内容变化加 1 |
| `exported_at` | string | 本次写出的时刻，ISO 8601，带时区（`EPHEMERA_TZ`） |
| `id` | int | 约会编号 |
| `paper_no` | string \| null | 纸面编号 `MMDD`，同一年同一天的第二个起加 `-2`、`-3` |
| `name` | string | 全名：英文名（中文名）；没有中文名时只有英文名 |
| `title_en` | string | 英文名（两行合成一行） |
| `title_zh` | string \| null | 中文名 |
| `date` | string | `YYYY-MM-DD` |
| `together_day` | int \| null | 在一起的第 N 天；没设 `EPHEMERA_TOGETHER_SINCE` 为 `null` |
| `names` | object | `{her, him}`：输出时的称呼 |
| `stops` | array | 见下 |
| `letters` | object | `{her, him}`：她的信、他的回信正文，没有为 `null` |
| `photos` | array | `[{stop_n, caption}]`：有小字的照片；`stop_n` 为 `null`=不挂在某一站 |
| `quote` | string \| null | 那一句话 |
| `card` | string \| null | 限定小卡 |
| `contract` | array \| null | 契约书条款（字符串数组） |
| `invite` | string \| null | 迟到的请柬（只有她补记的约会才有） |
| `closed_at` | string \| null | 结束时刻，ISO 8601 |
| `plan_version` | int | 约会本身的版本号 |

`stops[]`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `n` | int | 第几站，从 1 起 |
| `time` / `stay_until` | string \| null | `HH:MM` |
| `title` / `address` | string \| null | 地点名、地址 |
| `kind` | string \| null | 大类代码（19 种之一；没有固定地点的站为 `moment`） |
| `label` | string | 显示用的「大类·细类」（`dinner` 按时刻显示午餐/晚餐） |
| `no_place` | bool | 是否没有固定地点 |
| `clue` / `note` | string \| null | 线索、到站给她的话 |
| `her_line` | string \| null | 她在这一站写的一句话 |
| `skipped` | bool | 这一站当天被跳过了（`date_live op=skip`），站仍留在记录里 |
| `skip_reason` | string \| null | 跳过的原因（跳过时必写，≤60 字）；没跳过为 `null` |

JSON 不含坐标与照片文件本身。

## `date_memory` 工具

只查**已结束**的约会（进行中与构思中的用 `date_view`）。

- `op=find`（默认）：按 `name`（约会名）、`place`（站名或地址）、`from` / `to`（`YYYY-MM-DD`，含当天）查，可以组合；不带条件时从最近的列起。最多列 20 条摘要，其中前 3 条带全文。带 `plan` 只看这一次的全文。
- `op=followup`（只在设了 `EPHEMERA_CARDS_DIR` 时出现在工具说明里）：`plan` + `text`，写事件卡的「后续」段（≤600 字，整段替换）。
