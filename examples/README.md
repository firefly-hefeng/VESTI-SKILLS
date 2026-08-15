# examples

核心库的可运行示例。先在仓库根目录构建，再运行：

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm --filter vesti-skills-examples start
```

- [`basic-usage.mjs`](basic-usage.mjs) — `@vesti/memory-core` 最小端到端：
  临时目录建库（自动跑 15 个迁移）→ 写入会话与消息 → 用 mock LLM /
  mock embedder 跑 digest 管线 → FTS 召回验证写入即可检索。
