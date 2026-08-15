import { describe, expect, it, vi } from 'vitest';
import type { SessionDigest, SessionDigestStats, SessionMessage } from '../src/types.js';
import {
  DIGEST_VERSION,
  DigestService,
  buildDigestTranscript,
  isDegradedDigest,
  type DigestAgentRunner,
  type DigestEmbedder,
  type DigestSessionStore,
  type SessionDetail,
} from '../src/digest/DigestService.js';

function makeMessage(overrides: Partial<SessionMessage>): SessionMessage {
  return {
    id: 'm1',
    sessionId: 'codex:s1',
    source: 'user_input',
    role: 'user',
    contentText: '帮我实现登录功能',
    depth: 0,
    timestamp: 1000,
    createdAt: 1000,
    ...overrides,
  };
}

function makeDetail(id: string, messages: SessionMessage[]): SessionDetail {
  return {
    session: {
      id,
      sessionId: id.split(':')[1] ?? id,
      platform: 'codex',
      projectPath: 'C:\\work\\alpha',
      title: 'Session',
      tags: [],
      status: 'active',
      sessionType: 'conversation',
      startedAt: 1000,
      lastActivityAt: 2000,
      durationMs: 0,
      messageCount: messages.length,
      userInputCount: 0,
      assistantMessageCount: 0,
      thinkingCount: 0,
      toolCallCount: 0,
      codeBlockCount: 0,
      turnCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      hasSubagents: false,
      hasContextCompaction: false,
      createdAt: 1000,
      updatedAt: 2000,
    },
    messages,
  };
}

class FakeStore implements DigestSessionStore {
  details = new Map<string, SessionDetail>();
  digests = new Map<string, SessionDigest>();
  needing: Array<{ id: string; messageCount: number }> = [];

  getSessionDetail(id: string): SessionDetail | null {
    return this.details.get(id) ?? null;
  }
  listSessionsNeedingDigest(): Array<{ id: string; messageCount: number }> {
    return this.needing;
  }
  // Mirrors the DatabaseManager SQL pre-filter.
  listDegradedDigestCandidates(): SessionDigest[] {
    return [...this.digests.values()].filter(digest =>
      digest.embeddingStatus === 'skipped' &&
      digest.keyTopics.length === 0 &&
      digest.keyFiles.length === 0 &&
      digest.decisions.length === 0 &&
      digest.openQuestions.length === 0 &&
      digest.oneLiner.trim() !== '');
  }
  getSessionDigestStats(): SessionDigestStats {
    const all = [...this.digests.values()];
    return {
      total: all.length,
      emptyStructured: all.filter(digest =>
        digest.keyTopics.length === 0 &&
        digest.keyFiles.length === 0 &&
        digest.decisions.length === 0 &&
        digest.openQuestions.length === 0 &&
        digest.oneLiner.trim() !== '').length,
      gaveUp: all.filter(digest => digest.embeddingStatus === 'degraded').length,
      failed: all.filter(digest => digest.embeddingStatus === 'failed').length,
    };
  }
  upsertSessionDigest(digest: SessionDigest): void {
    this.digests.set(digest.sessionId, digest);
  }
}

const GOOD_PAYLOAD = {
  one_liner: '实现登录功能并接入 JWT',
  key_topics: ['认证', 'JWT'],
  key_files: ['src/Login.tsx'],
  decisions: ['使用 JWT'],
  open_questions: ['刷新令牌策略未定'],
};

function makeAgent(run: DigestAgentRunner['run']): DigestAgentRunner {
  return { run: vi.fn(run) };
}

function makeEmbedding(embed?: DigestEmbedder['embed']): DigestEmbedder {
  return { embed: vi.fn(embed ?? (async (texts: string[]) => texts.map(() => new Float32Array([1, 0, 0])))) };
}

function seededStore(): FakeStore {
  const store = new FakeStore();
  const messages = [
    makeMessage({ id: 'm1' }),
    makeMessage({ id: 'm2', role: 'assistant', source: 'assistant_text', contentText: '好的，先看一下现有代码' }),
  ];
  store.details.set('codex:s1', makeDetail('codex:s1', messages));
  store.needing = [{ id: 'codex:s1', messageCount: 2 }];
  return store;
}

describe('buildDigestTranscript', () => {
  it('keeps the newest messages within the character budget', () => {
    const messages = [
      makeMessage({ id: 'old', contentText: 'x'.repeat(500) }),
      makeMessage({ id: 'mid', contentText: 'y'.repeat(500) }),
      makeMessage({ id: 'new', contentText: '最新的一条消息' }),
    ];
    const transcript = buildDigestTranscript(messages, 600);
    expect(transcript).toContain('最新的一条消息');
    expect(transcript).toContain('y'.repeat(50));
    expect(transcript).not.toContain('x'.repeat(500));
    expect(transcript.length).toBeLessThanOrEqual(600);
  });

  it('summarizes tool calls and skips empty messages', () => {
    const messages = [
      makeMessage({
        id: 'tool',
        role: 'assistant',
        source: 'tool_request',
        contentText: undefined,
        contentToolName: 'Edit',
        contentToolOutput: 'done'.repeat(200),
      }),
      makeMessage({ id: 'empty', contentText: '   ' }),
    ];
    const transcript = buildDigestTranscript(messages);
    expect(transcript).toContain('工具：Edit');
    expect(transcript).toContain('工具结果：');
    expect(transcript.length).toBeLessThan(800);
  });
});

describe('DigestService', () => {
  it('writes a full digest with embedding on the happy path', async () => {
    const store = seededStore();
    const agent = makeAgent(async () => ({ content: JSON.stringify(GOOD_PAYLOAD) } as never));
    const embedding = makeEmbedding();
    const service = new DigestService(store, agent, embedding);

    await service.enqueuePending();

    const digest = store.digests.get('codex:s1');
    expect(digest).toBeDefined();
    expect(digest!.oneLiner).toBe(GOOD_PAYLOAD.one_liner);
    expect(digest!.keyTopics).toEqual(GOOD_PAYLOAD.key_topics);
    expect(digest!.keyFiles).toEqual(GOOD_PAYLOAD.key_files);
    expect(digest!.decisions).toEqual(GOOD_PAYLOAD.decisions);
    expect(digest!.openQuestions).toEqual(GOOD_PAYLOAD.open_questions);
    expect(digest!.embeddingStatus).toBe('ok');
    expect(digest!.embedding).toBeInstanceOf(Buffer);
    expect(digest!.digestVersion).toBe(DIGEST_VERSION);
    expect(digest!.messageCount).toBe(2);
    expect(digest!.platform).toBe('codex');
    expect(digest!.projectKey).toMatch(/^cli_[0-9a-f]{16}$/);

    // Digest runs never pollute the user-facing agent result log.
    expect(agent.run).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'digest', sessionId: 'codex:s1' }),
      { persist: false },
    );
    // Embedding text is one_liner + topics joined.
    const embedInput = (embedding.embed as ReturnType<typeof vi.fn>).mock.calls[0][0][0];
    expect(embedInput).toContain(GOOD_PAYLOAD.one_liner);
    expect(embedInput).toContain('认证');
  });

  it('retries once on malformed JSON and then succeeds', async () => {
    const store = seededStore();
    let calls = 0;
    const agent = makeAgent(async () => {
      calls += 1;
      if (calls === 1) return { content: '抱歉，我无法输出 JSON' } as never;
      return { content: JSON.stringify(GOOD_PAYLOAD) } as never;
    });
    const service = new DigestService(store, agent, makeEmbedding());

    await service.enqueuePending();

    expect(agent.run).toHaveBeenCalledTimes(2);
    expect(store.digests.get('codex:s1')!.oneLiner).toBe(GOOD_PAYLOAD.one_liner);
  });

  it('degrades to a structural row after two malformed outputs', async () => {
    const store = seededStore();
    const agent = makeAgent(async () => ({ content: 'not json at all' } as never));
    const embedding = makeEmbedding();
    const service = new DigestService(store, agent, embedding);

    await service.enqueuePending();

    expect(agent.run).toHaveBeenCalledTimes(2);
    const digest = store.digests.get('codex:s1')!;
    expect(digest.oneLiner).toBe('帮我实现登录功能');
    expect(digest.keyTopics).toEqual([]);
    expect(digest.embeddingStatus).toBe('skipped');
    expect(embedding.embed).not.toHaveBeenCalled();
  });

  it('degrades when the LLM is not configured', async () => {
    const store = seededStore();
    const agent = makeAgent(async () => {
      throw new Error('请先在设置中填写 API Key');
    });
    const service = new DigestService(store, agent, makeEmbedding());

    await service.enqueuePending();

    const digest = store.digests.get('codex:s1')!;
    expect(digest.oneLiner).toBe('帮我实现登录功能');
    expect(digest.embeddingStatus).toBe('skipped');
  });

  it('marks embedding as skipped when the embedding service is unavailable', async () => {
    const store = seededStore();
    const agent = makeAgent(async () => ({ content: JSON.stringify(GOOD_PAYLOAD) } as never));
    const embedding = makeEmbedding(async () => {
      throw new Error('Embedding 服务不可用');
    });
    const service = new DigestService(store, agent, embedding);

    await service.enqueuePending();

    const digest = store.digests.get('codex:s1')!;
    expect(digest.oneLiner).toBe(GOOD_PAYLOAD.one_liner);
    expect(digest.embeddingStatus).toBe('skipped');
    expect(digest.embedding).toBeNull();
  });

  it('dedupes sessions already in the queue', async () => {
    const store = seededStore();
    store.needing = [
      { id: 'codex:s1', messageCount: 2 },
      { id: 'codex:s1', messageCount: 2 },
    ];
    const agent = makeAgent(async () => ({ content: JSON.stringify(GOOD_PAYLOAD) } as never));
    const service = new DigestService(store, agent, makeEmbedding());

    await service.enqueuePending();

    expect(agent.run).toHaveBeenCalledTimes(1);
  });

  it('retries hard failures up to twice, then gives up without throwing', async () => {
    const store = seededStore();
    store.upsertSessionDigest = () => {
      throw new Error('database is locked');
    };
    const agent = makeAgent(async () => ({ content: JSON.stringify(GOOD_PAYLOAD) } as never));
    const service = new DigestService(store, agent, makeEmbedding());

    await expect(service.enqueuePending()).resolves.toBeUndefined();
    // 1 initial attempt + 2 retries; then the failed-row write also fails silently.
    expect(agent.run).toHaveBeenCalledTimes(3);
    expect(store.digests.size).toBe(0);
  });

  it('skips sessions with no usable content', async () => {
    const store = new FakeStore();
    store.details.set('codex:empty', makeDetail('codex:empty', [
      makeMessage({ id: 'blank', contentText: '   ' }),
    ]));
    store.needing = [{ id: 'codex:empty', messageCount: 1 }];
    const agent = makeAgent(async () => ({ content: JSON.stringify(GOOD_PAYLOAD) } as never));
    const service = new DigestService(store, agent, makeEmbedding());

    await service.enqueuePending();

    expect(agent.run).not.toHaveBeenCalled();
    expect(store.digests.size).toBe(0);
  });
});

function degradedRow(sessionId: string, oneLiner: string): SessionDigest {
  return {
    sessionId,
    host: 'native',
    platform: 'codex',
    projectKey: 'cli_0123456789abcdef',
    oneLiner,
    keyTopics: [],
    keyFiles: [],
    decisions: [],
    openQuestions: [],
    embedding: null,
    embeddingStatus: 'skipped',
    digestVersion: DIGEST_VERSION,
    messageCount: 2,
    updatedAt: new Date().toISOString(),
  };
}

describe('isDegradedDigest', () => {
  const empty = { keyTopics: [], keyFiles: [], decisions: [], openQuestions: [] };

  it('flags a truncated raw first user message (fallback row shape)', () => {
    const first = '请在这个仓库里完成一个非常长的任务描述，'.repeat(10);
    const oneLiner = first.slice(0, 100);
    expect(isDegradedDigest({ oneLiner, ...empty }, first)).toBe(true);
  });

  it('flags an echo of the first user message (>80% bigram overlap)', () => {
    const first = '请帮我优化这个项目的构建速度，现在太慢了';
    expect(isDegradedDigest({ oneLiner: first.slice(0, -1), ...empty }, first)).toBe(true);
    expect(isDegradedDigest({ oneLiner: first, ...empty }, first)).toBe(true);
  });

  it('does not flag a healthy digest with structured content', () => {
    const first = '请帮我优化这个项目的构建速度，现在太慢了';
    expect(isDegradedDigest({ oneLiner: first, ...empty, keyTopics: ['构建'] }, first)).toBe(false);
  });

  it('does not flag a genuine summary of the first user message', () => {
    expect(isDegradedDigest(
      { oneLiner: '实现登录功能并接入 JWT', ...empty },
      '帮我实现登录功能',
    )).toBe(false);
  });

  it('does not flag empty one_liners', () => {
    expect(isDegradedDigest({ oneLiner: '', ...empty }, '帮我实现登录功能')).toBe(false);
  });
});

describe('DigestService degraded retries', () => {
  function degradedStore(): FakeStore {
    const store = seededStore();
    store.needing = []; // the normal scan does NOT pick degraded rows up
    store.digests.set('codex:s1', degradedRow('codex:s1', '帮我实现登录功能'));
    return store;
  }

  it('heals a degraded row when the LLM is configured', async () => {
    const store = degradedStore();
    const agent = makeAgent(async () => ({ content: JSON.stringify(GOOD_PAYLOAD) } as never));
    const service = new DigestService(store, agent, makeEmbedding(), () => true);

    await service.enqueuePending();

    expect(agent.run).toHaveBeenCalledTimes(1);
    const digest = store.digests.get('codex:s1')!;
    expect(digest.oneLiner).toBe(GOOD_PAYLOAD.one_liner);
    expect(digest.keyTopics).toEqual(GOOD_PAYLOAD.key_topics);
    expect(digest.embeddingStatus).toBe('ok');
    expect(service.getDigestStats().run.degradedRetries).toBe(1);
  });

  it('does not touch degraded rows while the LLM is not configured', async () => {
    const store = degradedStore();
    const agent = makeAgent(async () => ({ content: JSON.stringify(GOOD_PAYLOAD) } as never));
    const service = new DigestService(store, agent, makeEmbedding(), () => false);

    await service.enqueuePending();

    expect(agent.run).not.toHaveBeenCalled();
    expect(store.digests.get('codex:s1')!.embeddingStatus).toBe('skipped');
  });

  it('keeps the row skipped (recoverable) when the retry LLM call fails, once per run', async () => {
    const store = degradedStore();
    const agent = makeAgent(async () => ({ content: 'not json at all' } as never));
    const service = new DigestService(store, agent, makeEmbedding(), () => true);

    await service.enqueuePending();
    expect(agent.run).toHaveBeenCalledTimes(2); // one retry pass = two attempts
    // A transport/parse failure says nothing about the session — the row
    // stays 'skipped' so a healthy LLM in a later run can regenerate it.
    expect(store.digests.get('codex:s1')!.embeddingStatus).toBe('skipped');

    // The per-run attempted set stops same-run retry storms.
    await service.enqueuePending();
    expect(agent.run).toHaveBeenCalledTimes(2);
    const stats = service.getDigestStats();
    expect(stats.run.degradedGaveUp).toBe(0);
    expect(stats.store.gaveUp).toBe(0);
    expect(stats.store.emptyStructured).toBe(1);
  });

  it('marks the row degraded when the retry output is still an echo', async () => {
    const store = degradedStore();
    const echoPayload = {
      one_liner: '帮我实现登录功能',
      key_topics: [],
      key_files: [],
      decisions: [],
      open_questions: [],
    };
    const agent = makeAgent(async () => ({ content: JSON.stringify(echoPayload) } as never));
    const service = new DigestService(store, agent, makeEmbedding(), () => true);

    await service.enqueuePending();

    const digest = store.digests.get('codex:s1')!;
    expect(digest.embeddingStatus).toBe('degraded');
    expect(digest.oneLiner).toBe('帮我实现登录功能');
    expect(service.getDigestStats().run.degradedGaveUp).toBe(1);
  });
});
