---
name: vesti-handoff
description: Produce a schema'd work handoff (交接包) when handing a task to another AI/session — context compaction, cross-agent relay ("把工作交接给…", "换个工具继续", "生成 handoff"), or before /compact. Encodes the verify-first rule: the receiving agent must re-verify the last verified result before trusting the handoff.
---

# VESTI Handoff — 结构化工作交接（含接手先验证规则）

把当前工作压缩为下一会话/另一个 AI 可直接接手的交接文档。**清单类信息（文件、命令、git 状态）从真实记录提取，不凭印象罗列**；叙事类由你归纳。

## 交接文档结构（按此顺序）

```markdown
# 交接：<任务一句话>
> 另一个 AI 产出了以下工作摘要。请在已有基础上继续，避免重复劳动。
> **在采信最后的结论之前，先回到「验证」一节重新跑一遍最后一条验证命令，确认无误后再继续。**

## 目标（Goal）
做完是什么样（一两句，可检验）。

## 已完成（Completed）
- 每条带证据锚点：文件路径 / 命令输出 / 会话引用。

## 进行中（In Progress）
- 当前停在哪一步、为什么。

## 关键决策（Key Decisions）
- 选了什么 + 否决了什么 + 原因。

## 关键文件（Key Files）
| 路径 | 为什么重要 | 最后状态 |
（从工具调用/编辑记录确定性提取，禁止虚构；每条带来源）

## 失败死路（Ruled Out）
- 试过什么 → 结果如何 → 为什么放弃。（最贵、最易丢的一段，必须保留）

## 验证（Verification）
- 验证命令 + 最近一次实际结果（时间）。接手方第一条必须重跑。

## 下一步（Next Steps）
- 每条自包含、离开本聊天也能执行；第一条 = 重跑验证。

## 置信度
- 整体 0-100% + 低置信区域（哪些部分需要接手方重点复核）。
```

## 守则

- **接手先验证**：无论交接方多可信，先把「验证」节最后一条命令重跑一遍——"报告说完成"不等于完成。
- 失败尝试与否决原因**完整保留**，不许美化成"一切顺利"。
- 文件清单只列真实碰过的（编辑/读取/引用）；不确定的条目标「待核实」。
- 交接文档本身落盘（如 `HANDOFF.md` 或交给 VESTI 沉淀区），不要只存在于对话里。
