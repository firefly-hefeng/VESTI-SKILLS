---
name: vesti-memory
description: Recall past AI coding sessions (kimi-code / Claude Code / Codex / Cursor) captured by VESTI. Use when the user references earlier work ("继续上次…", "之前我们…", when starting a task in a repo with history, or when current context is missing decisions made earlier). Provides a three-layer progressive-disclosure memory: cheap index first, full content only when needed.
---

# VESTI Memory — 用三层渐进披露检索历史会话记忆

VESTI 在本机持续采集你与各 AI coding agent 的历史会话（含工具调用、子代理、文件改动），并以只读 MCP server 暴露检索接口。**先索引、再定位、后取全文**——不要跳过层级直接拉全文。

## 工具与用法

按以下顺序使用（每层便宜一个数量级）：

1. **vesti_search(query, topK=8)** — 会话级索引。返回 session_id、标题、平台、项目路径、时间、digest 一句话、关键主题、命中片段与 `confidence`。
   - 查询用**名词/文件名/决策关键词**，中英文皆可（底层 trigram FTS）。
   - `confidence:"low"` 的结果只作线索，**不要当作事实**；换关键词重试或明确告诉用户"记忆中没有找到"。
2. **vesti_timeline(session_id, around_turn?)** — 单会话 turn 大纲（序号/时间/用户意图一行/工具数/token）。用它定位需要哪几轮，不要盲取。
3. **vesti_get_turns(session_id, turn_ids | range, max_chars=8000)** — 取指定轮完整内容（用户/助手原文 + 工具调用摘要）。只在确定范围后调用；`truncated:true` 时按 seq 继续取。
4. **vesti_project_brief(project)** — 项目级简报（L0 状态卡 + 跨会话合并的当前状态/关键文件/决策日志/未决项）。开始一个项目的续作时**先取它**，往往一步到位，无需再搜。

## 工作守则

- **交接/续作场景**：先 `vesti_project_brief(项目名)`，再对缺失点 `vesti_search`，最后按需 `vesti_get_turns`。引用记忆内容时给出来源（会话标题/时间），让用户可回查。
- **时效性**：记忆条目带时间；同一事实新旧冲突时以**更近的会话**为准，并提醒用户发生过变更。
- **边界**：库是只读的；查不到就如实说查不到，不要编造"记忆中"的内容。
- 未注册 MCP 时提示用户按 README 注册（stdio，Node ≥23.4，或 22.x 加 `--experimental-sqlite`）。
