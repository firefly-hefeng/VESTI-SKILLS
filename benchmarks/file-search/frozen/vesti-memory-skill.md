---
name: vesti-memory
description: 'Recall past AI coding sessions and file touches captured by VESTI. Use when the user references earlier work ("继续上次…", "之前我们…"), asks which local file or project contained prior work, starts a session in a tracked project, merges work across projects or branches, or needs a decision made in missing context. Provides project context, file-level lookup, and progressive retrieval from session index to selected full turns.'
---

# VESTI Memory — 项目上下文、文件定位与渐进检索

VESTI 在本机持续采集你与各 AI coding agent 的历史会话（含工具调用、子代理、文件改动），并以只读 MCP server 暴露检索接口。

## 会话开始：先拉项目上下文

处于已跟踪项目时，**先调一次 `vesti_get_project_context`** 再动手，不要向用户重复索要背景：

- **vesti_get_project_context(paths?)** — 项目"自动上下文包"。每个路径返回：L0 状态卡（一句话/活跃文件/未决问题）+ L2 维护简报 + 最近会话列表（标题/时间/一句话）+ 合并的未决问题 + 确定性活跃文件时间线。
  - `paths[0]` 传你的**当前工作目录**；不传时默认最近活跃的项目。
  - **合并/跨项目任务**：一次传入多个项目路径，响应附带 `cross_project`——共享文件、共享主题、会话时间交叠，直接支撑"基于几个分支开合并项目"。
  - 路径出现在 `unmatched_paths` = 该项目未被 VESTI 跟踪（hints 里附已知项目列表），此后按无记忆处理，不要再反复重试。
  - 拿到上下文包后仍有缺口，再走下面的三层检索。

## 需要定位文件时：先查文件级记忆

- 用户问“上次 OAuth 改在哪个文件”“填写之前做过的 BP”或需要把历史工作落到当前代码时，先调用 **`vesti_search_files(query, topK=10)`**。
- 把返回的 `path`、`projects`、`last_touched` 和 backing sessions 当作历史证据；先确认项目范围，再用当前 Agent 的文件系统工具检查路径是否仍存在并读取最新内容。
- 该工具搜索的是 VESTI 记录的历史文件触碰，不搜索当前磁盘内容。用户问“当前目录里有没有某文件”时，直接使用文件系统搜索。
- 工具列表中没有 `vesti_search_files` 时，说明 MCP 版本较旧；退回 `vesti_search(文件名/主题)` → `vesti_timeline` → `vesti_get_turns`，并把推断出的路径标为待核实。

## 需要历史细节时：三层渐进披露

按以下顺序使用（每层便宜一个数量级），**不要跳过层级直接拉全文**：

1. **vesti_search(query, topK=8)** — 会话级索引。返回 session_id、标题、平台、项目路径、时间、digest 一句话、关键主题、命中片段与 `confidence`。
   - 查询用**名词/文件名/决策关键词**，中英文皆可（底层 trigram FTS）。
   - `confidence:"low"` 的结果只作线索，**不要当作事实**；换关键词重试或明确告诉用户"记忆中没有找到"。
2. **vesti_timeline(session_id, around_turn?)** — 单会话 turn 大纲（序号/时间/用户意图一行/工具数/token）。用它定位需要哪几轮，不要盲取。
3. **vesti_get_turns(session_id, turn_ids | range, max_chars=8000)** — 取指定轮完整内容（用户/助手原文 + 工具调用摘要）。只在确定范围后调用；`truncated:true` 时按 seq 继续取。

只知道项目名而不知道路径时使用 **`vesti_project_brief(project)`**；知道路径时优先使用 `vesti_get_project_context`。

## 交接前

- **vesti_get_handoff_context(path | session_id, user_messages=8)** — 轻量交接材料，与 relay v2 对齐：项目上下文块 + 最近 N 条用户消息 + **文件锚点**（确定性活跃文件时间线）+ **verify_first 种子**（待确认的未决问题、上次失败的步骤复查）。全部来自存储数据，无编造。
- 拿到材料后按 **vesti-handoff** skill 的 V2 schema 组装交接包（goal/state/decisions 由你归纳，清单类只用锚点数据）；长 transcript 重压缩交给 VESTI app 侧 relay 管线，不在 MCP 做。

## 工作守则

- **续作场景**：`vesti_get_project_context(当前目录)` → 文件问题用 `vesti_search_files`，决策问题用 `vesti_search` → 按需 `vesti_timeline` / `vesti_get_turns`。引用记忆内容时给出来源（会话标题/时间），让用户可回查。
- **时效性**：记忆条目带时间；同一事实新旧冲突时以**更近的会话**为准，并提醒用户发生过变更。
- **边界**：库是只读的；查不到就如实说查不到，不要编造"记忆中"的内容。
- 未注册 MCP 时提示用户按 README 注册（stdio，Node ≥23.4，或 22.x 加 `--experimental-sqlite`；也可在 VESTI app 设置页"连接到 Agent"一键注册）。
