---
name: vesti-file-locator-v2
description: Locate files mentioned in captured past AI coding sessions with VESTI. Use for historical file-location questions, same-project or cross-project multi-file lookups, paths whose current existence is uncertain, and requests that need supporting session details.
---

# VESTI 历史文件定位

把结果视为会话中留下的历史文件证据，而不是当前磁盘状态。目标是以最少调用给出完整、可回查且不过度推断的结果。

## 1. 保留查询约束

- 从用户原话中分离语义意图、文件锚点和项目限定；首轮不得把问题改写成更宽泛的主题。
- 原样保留完整 basename、扩展名、连字符、数字、错误码、API 名和罕见中英文 token；不要拆掉或省略区分性 token。
- 仅当用户明确说明项目、仓库、工作区或路径时，才把经候选验证的值传入 `project`；不得把并列的未知标识猜成项目。
- 多项目问题逐项限定；未明确项目时不传 `project`。

## 2. 先做文件级定位

- 首先调用 `vesti_search_files`。单文件问题使用 `topK=8`；同项目多文件使用 `topK=15`；跨项目、高扇出或数量不明的问题使用 `topK=25`。
- 已知单个项目时传入精确路径或无歧义名称。明确多个项目时，对每个项目分别调用并使用相同的核心 query；不要把多个项目名拼成一次普通查询。
- 首轮结果已同时满足完整 basename、必要 token、项目限定且带有支撑会话时，立即停止。后续宽泛结果不得推翻更具体的匹配。
- 只在某个必要锚点或指定项目缺失时进行一次收窄调用；保留原锚点，仅补充缺失条件，不要改成泛化主题。
- 不按会话平均分配名额；只保留满足用户全部约束所需的最小文件集合。覆盖已满足就停止，删除只匹配宽主题的额外项。

## 3. 检查充分性与覆盖

- 单文件任务：确认候选路径同时满足 basename 或全部必要 token、项目范围和至少一个 backing session。
- 同项目多文件任务：确认各角色、明确数量或用户列出的组成均有独立支持；缺少任一必需项就标明不完整。
- 跨项目任务：确认每个指定项目至少有一个符合约束的结果，并分别保留其项目路径；不得用一个项目中的多个文件冒充跨项目覆盖。
- 查询含字母数字混合词、错误码、API 名或其他罕见标识时，即使组合查询已有候选，也必须额外用该标识单独调用一次 `vesti_search_files`；单独查询为 0 或候选证据不含其原文，就淘汰组合查询的全部宽主题结果。
- 最终对每个候选执行全约束合取；任一必要 token 缺失就返回 `answerable: false` 和 `files: []`，不得用宽主题、部分 token、编号碰撞或其他项目替代。

## 4. 区分历史与当前状态

- 每个输出项只使用 `path`、单数 `project`、`evidence_session_ids` 和 `historical_only`；不要增加其他字段。
- 从命中项的项目值中选择与用户限定对应的单个 `project`；没有可用值时使用 `null`，不得猜测。
- 若没有受限文件系统能力，设置 `historical_only: true`，并且不得声称路径当前仍在、内容未变或可以直接打开。
- 若具备受限文件系统能力，只核验候选路径是否存在；只有当前状态得到独立核验时才设置 `historical_only: false`。

## 5. 仅按需展开细节

- 用户只问位置时，直接给出满足约束的最小结果，不读取长对话。
- 用户要求原因、修改内容或上下文时，只对已选结果的 backing session 调用 `vesti_timeline(session_id)`，定位相关 turn 后再调用 `vesti_get_turns`。
- 最终严格按既定 schema 返回；多文件任务在 explanation 中说明覆盖是否完整，信息不足时明确缺口，不补写猜测。
