---
name: vesti-file-locator-v3
description: Locate files mentioned in captured past AI coding sessions with VESTI. Use for historical file-location questions, ambiguous or repeated filenames, same-project or cross-project multi-file lookups, and requests that need session-backed evidence.
---

# VESTI 历史文件定位

把 `vesti_search_files` 的结果视为候选，不视为最终证据。仅返回被完整查询锚点与具体历史会话共同支持的最小文件集合。

## 工作流

1. 从用户原话提取并原样保留完整 basename、扩展名、错误码、API 名、罕见标识、文件角色和明确的项目或路径限定。不要把查询改写成宽泛主题，也不要猜测未说明的项目。
2. 先调用 `vesti_search_files` 生成候选。单文件通常使用 `topK=8`，多文件或跨项目使用 `topK=15`。项目明确且无歧义时传入 `project`；多个明确项目分别查询。
3. 只有当候选唯一，且 basename、全部必要锚点、项目限定和 backing session 均无歧义时，才可直接选择该候选。
4. 出现同名文件、多个合理候选、多文件、跨项目或证据摘要不足时，必须以保留全部必要锚点的完整查询调用 `vesti_search`。仅把完整锚点命中的会话标为已验证会话；若摘要仍不足，先用 `vesti_timeline` 定位相关轮次，再用 `vesti_get_turns` 核对原文。
5. 用已验证会话筛选文件候选：只保留 `evidence_session_ids` 与已验证会话有交集、且同时满足路径、basename、项目和角色约束的候选。不得把宽泛查询、basename 单查或不同会话的结果做并集。
6. 多文件任务只返回由已验证会话支持、满足用户所列角色或数量的最小完整组；任一必需文件缺证据时不要补猜。跨项目任务只保留各项目中有完整锚点命中会话的候选；项目数量未知时，以这些已验证会话实际覆盖的项目为准。
7. 对用户明确给出的错误码、API 名或字母数字混合罕见标识，可用该标识单独调用一次 `vesti_search_files` 作为必要条件检查。若结果为 0，返回不可回答；若有结果，它们仍只能用于过滤，不得加入结果集合。

## 返回规则

- 对每个文件只返回 `path`、单数 `project`、支撑该文件的已验证 `evidence_session_ids` 和 `historical_only`。
- 这些工具只证明历史会话中的文件记录，因此设置 `historical_only: true`；不得声称路径当前存在、内容未变或可以打开。
- 仅在全部必需约束和覆盖均得到验证时设置 `answerable: true`。没有合格文件、罕见必要标识缺失或多文件集合不完整时，设置 `answerable: false` 且 `files: []`。
- explanation 简短说明证据覆盖或缺口，不添加未经会话支持的推断。
