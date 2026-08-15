/**
 * @vesti/memory-core 最小端到端示例。
 *
 * 流程：临时目录建库 → 写入一条会话与消息 → 用 mock LLM / mock embedder
 * 跑 digest 管线 → FTS 召回验证「写入即可检索」。
 *
 * 运行前先构建：`corepack pnpm build`，然后 `node basic-usage.mjs`。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DatabaseManager,
  DigestService,
} from '@vesti/memory-core';

// ---- 1. 在临时目录初始化数据库（15 个迁移自动执行）----

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesti-memory-core-demo-'));
const manager = new DatabaseManager(path.join(dir, 'vesti.db'));
await manager.initialize();

// ---- 2. 写入一条工作会话与两条消息 ----

const now = Date.now();
manager.upsertWorkSession({
  id: 'claude-code:demo-001',
  sessionId: 'demo-001',
  platform: 'claude-code',
  projectPath: '/tmp/demo-project',
  title: '演示：事务迁移',
  tags: [],
  status: 'active',
  sessionType: 'conversation',
  startedAt: now - 60_000,
  lastActivityAt: now,
  durationMs: 60_000,
  messageCount: 2,
  userInputCount: 1,
  assistantMessageCount: 1,
  thinkingCount: 0,
  toolCallCount: 0,
  codeBlockCount: 0,
  turnCount: 1,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheCreationTokens: 0,
  totalCacheReadTokens: 0,
  hasSubagents: false,
  hasContextCompaction: false,
  createdAt: now - 60_000,
  updatedAt: now,
});
manager.insertSessionMessages([
  {
    id: 'msg-1',
    sessionId: 'claude-code:demo-001',
    source: 'user_input',
    sequence: 0,
    role: 'user',
    contentText: '帮我给数据库迁移加上事务保护，超时时间定为 30s',
    timestamp: now - 50_000,
    createdAt: now - 50_000,
  },
  {
    id: 'msg-2',
    sessionId: 'claude-code:demo-001',
    source: 'assistant_text',
    sequence: 1,
    role: 'assistant',
    contentText: '已为全部 15 个迁移包了事务，超时 30s，并补了回滚测试。',
    timestamp: now - 40_000,
    createdAt: now - 40_000,
  },
]);

// ---- 3. 注入 mock LLM 与 mock embedder，跑 digest 管线 ----
//
// 真实使用时把这两个接口接到自己的模型服务上即可；digest 的 prompt 组装、
// 数值事实预提取、降级重试、embedding 落库都由 DigestService 负责。

const mockAgent = {
  async run() {
    return {
      content: JSON.stringify({
        one_liner: '为 15 个数据库迁移加上事务保护，超时定为 30s',
        key_topics: ['数据库迁移', '事务'],
        key_files: ['src/storage/migrations.ts'],
        decisions: ['迁移超时时间定为 30s'],
        open_questions: [],
      }),
    };
  },
};
const mockEmbedder = {
  async embed(texts) {
    // 演示用的确定性伪向量：按字符码求和，8 维。生产环境换成真实 embedding。
    return texts.map(text => {
      const v = new Float32Array(8);
      for (const ch of text) v[ch.codePointAt(0) % 8] += 1;
      return v;
    });
  },
};

const digest = new DigestService(manager, mockAgent, mockEmbedder);
await digest.enqueuePending(); // 处理所有缺 digest 的会话（这里是 demo-001）

const stored = manager.getSessionDigest('claude-code:demo-001');
console.log('digest 落库：');
console.log('  one_liner      =', stored?.oneLiner);
console.log('  key_files      =', stored?.keyFiles);
console.log('  embedding 状态 =', stored?.embeddingStatus);

// ---- 4. FTS 召回：写入的会话立即可被检索 ----
//
// 注意：FTS5 trigram 分词要求查询词至少 3 个字符（两个字符的中文词
// 匹配不到），真实场景的长查询不受影响。

const hits = manager.recallSessions('数据库迁移', { topK: 5 });
console.log('\nmanager.recallSessions("数据库迁移") →');
for (const hit of hits) {
  console.log(`  ${hit.sessionId}  score=${hit.score.toFixed(3)}`);
}

await manager.close();
fs.rmSync(dir, { recursive: true, force: true });
