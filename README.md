# VESTI Skills

面向 AI coding agent（kimi-code / Claude Code / Codex 等）的开源技能包，由 [VESTI](https://github.com/firefly-hefeng/VESTI-APP)（本地优先的 AI 对话记忆库）配套产出。把 `skills/<name>/` 拷进你的 agent 技能目录即可使用。

## 技能清单

| 技能 | 用途 |
|---|---|
| [vesti-memory](skills/vesti-memory/SKILL.md) | 用三层渐进披露（search → timeline → get_turns + project_brief）检索 VESTI 采集的历史会话记忆：续作、回查决策、跨工具接力时的上下文找回 |
| [vesti-handoff](skills/vesti-handoff/SKILL.md) | 生成结构化交接包（目标/已完成/关键文件/失败死路/验证/下一步），内置「接手先验证」规则——跨会话、跨 agent 交接不丢工程学状态 |

## 安装

**kimi-code**：拷到 `~/.kimi-code/skills/`（或项目级 `.kimi-code/skills/`）
**Claude Code**：拷到 `~/.claude/skills/`（或项目级 `.claude/skills/`）
**其他 agent**：按其 skills/prompt 约定引入 `SKILL.md` 全文即可

```bash
git clone https://github.com/firefly-hefeng/VESTI-SKILLS.git
# 示例（Windows Git Bash，kimi-code 用户级）
cp -r VESTI-SKILLS/skills/vesti-memory ~/.kimi-code/skills/
cp -r VESTI-SKILLS/skills/vesti-handoff ~/.kimi-code/skills/
```

`vesti-memory` 需要本机运行 VESTI 并注册 vesti-mcp（见 VESTI-APP 仓库 packages/vesti-mcp/README.md）；`vesti-handoff` 独立可用。

## License

MIT
