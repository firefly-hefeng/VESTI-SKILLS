---
name: vesti-handoff
description: Produce a schema'd work handoff (交接包) when handing a task to another AI/session — context compaction, cross-agent relay ("把工作交接给…", "换个工具继续", "生成 handoff"), or before /compact. Encodes the verify-first rule: the receiving agent must re-verify the last verified result before trusting the handoff. V2 format aligns with VESTI-APP's RelayPackV2 schema.
---

# VESTI Handoff V2 — 结构化工作交接（含接手先验证规则）

把当前工作压缩为下一会话/另一个 AI 可直接接手的交接文档。**清单类信息（文件、命令、git 状态）从真实记录提取，不凭印象罗列**；叙事类由你归纳。

## V2 格式（与 VESTI-APP Relay Pack 对齐）

```json
{
  "meta": { "version": 2, "createdAt": "<ISO 8601>", "conversationCount": 1 },
  "goal": "可检验的目标（一两句）",
  "state": {
    "completed": ["已完成事项 + 证据锚点"],
    "inProgress": ["进行中事项 + 停在哪一步"],
    "blocked": ["被阻塞事项 + 阻塞原因"]
  },
  "files": [
    { "path": "真实碰过的文件路径", "why": "为什么重要", "last_state": "目前改动状态" }
  ],
  "decisions": [
    { "decision": "做了什么决定", "rationale": "理由 + 否决的替代方案" }
  ],
  "failedPaths": [
    { "approach": "试过的方案", "whyFailed": "失败原因", "evidence": "上下文中的证据位置" }
  ],
  "verification": {
    "lastCommand": "最后执行的验证命令",
    "lastResult": "最近一次输出",
    "passed": true
  },
  "nextSteps": ["按优先级排序的下一步"],
  "confidence": { "overall": 0.85, "lowAreas": ["低置信区域"] },
  "environment": {
    "gitBranch": "分支名",
    "gitRemote": "远程地址",
    "dirtyFiles": ["未提交文件"],
    "nodeVersion": "v20.x",
    "packageManager": "pnpm"
  },
  "handoffPrompt": "【交接说明】以下内容来自另一个 AI…（完整交接提示词）"
}
```

## 交接文档结构（Markdown 可读版本，按此顺序）

```markdown
# 交接：<任务一句话>
> 另一个 AI 产出了以下工作摘要。请在已有基础上继续，避免重复劳动。
> **在采信最后的结论之前，先回到「验证」一节重新跑一遍最后一条验证命令，确认无误后再继续。**

## 目标（Goal）
做完是什么样（一两句，可检验）。

## 状态（State）
### 已完成（Completed）
- 每条带证据锚点：文件路径 / 命令输出 / 会话引用。

### 进行中（In Progress）
- 当前停在哪一步、为什么。

### 被阻塞（Blocked）
- 哪些事项因未解决的依赖而无法推进。

## 关键决策（Key Decisions）
- 选了什么 + 否决了什么 + 原因。

## 关键文件（Key Files）
| 路径 | 为什么重要 | 最后状态 |
（从工具调用/编辑记录确定性提取，禁止虚构；每条带来源）

## 失败死路（Failed Paths）
- 试过什么 → 结果如何 → 为什么放弃。（最贵、最易丢的一段，必须保留）
- 每条附带证据位置（哪个会话/消息显示了该失败）

## 验证（Verification）
- 最后执行的验证命令 + 最近一次实际结果（时间）。
- 标注通过/失败状态。接手方第一条必须重跑。

## 下一步（Next Steps）
- 每条自包含、离开本聊天也能执行；第一条 = 重跑验证。

## 置信度
- 整体 0-100% + 低置信区域（哪些部分需要接手方重点复核）。

## 环境（Environment）
- Git 分支/远程、Node/包管理版本等可重现的环境信息。
```

## 守则

- **接手先验证**：无论交接方多可信，先把「验证」节最后一条命令重跑一遍——"报告说完成"不等于完成。
- 失败尝试与否决原因**完整保留**，不许美化成"一切顺利"；每条致命 `evidence` 指向上下文中的证据。
- 文件清单只列真实碰过的（编辑/读取/引用）；不确定的条目标「待核实」。
- **阻塞项与进行中区分**：因依赖未满足而无法推进的标为 blocked，正在做的标为 inProgress。
- **决策要写否决方案**：不光写做了什么决定，还要写否决了哪些替代方案及原因。
- 交接文档本身落盘（如 `HANDOFF.md` 或交给 VESTI 沉淀区），不要只存在于对话里。
- V2 JSON 格式与 VESTI-APP Relay Pack 对齐，确保机器可读。
