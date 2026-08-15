import { describe, expect, it } from 'vitest';
import type { SessionMessage } from '../src/types.js';
import {
  buildDigestTranscript,
  formatDigestMessage,
  isFileWriteTool,
  truncateForDigest,
} from '../src/digest/transcript.js';

function makeMessage(overrides: Partial<SessionMessage>): SessionMessage {
  return {
    id: 'm1',
    sessionId: 'codex:s1',
    source: 'user_input',
    role: 'user',
    contentText: '消息',
    depth: 0,
    timestamp: 1000,
    createdAt: 1000,
    ...overrides,
  };
}

function filler(index: number, chars = 12): SessionMessage {
  return makeMessage({
    id: `f${index}`,
    role: index % 2 === 0 ? 'assistant' : 'user',
    contentText: `第${index}条` + '话'.repeat(chars),
  });
}

describe('isFileWriteTool', () => {
  it('recognizes write tools case-insensitively and rejects read-only ones', () => {
    expect(isFileWriteTool('Edit')).toBe(true);
    expect(isFileWriteTool('write')).toBe(true);
    expect(isFileWriteTool('edit_file_v2')).toBe(true);
    expect(isFileWriteTool('delete_file')).toBe(true);
    expect(isFileWriteTool('Read')).toBe(false);
    expect(isFileWriteTool('Bash')).toBe(false);
    expect(isFileWriteTool(undefined)).toBe(false);
  });
});

describe('truncateForDigest', () => {
  it('keeps short text intact', () => {
    expect(truncateForDigest('短消息', 100, false)).toBe('短消息');
  });

  it('head-truncates normal overflow with a mark', () => {
    const text = 'x'.repeat(500);
    const out = truncateForDigest(text, 100, false);
    expect(out.length).toBe(100);
    expect(out.endsWith('……[截断]')).toBe(true);
  });

  it('keeps head AND tail for oversized messages with an elision mark', () => {
    const text = `${'头'.repeat(8000)}中间${'尾'.repeat(8000)}`;
    const out = truncateForDigest(text, 600, true);
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out).toContain('中间省略');
    expect(out.startsWith('头'.repeat(100))).toBe(true);
    expect(out.endsWith('尾'.repeat(100))).toBe(true);
    // The original middle segment is gone (the mark itself says 中间省略).
    expect(out).not.toContain('头中间');
  });
});

describe('buildDigestTranscript v2', () => {
  it('a single giant message can no longer starve the window (oversized cap)', () => {
    const messages = [
      makeMessage({ id: 'first', contentText: '修复登录 bug' }),
      makeMessage({ id: 'giant', role: 'assistant', contentText: 'G'.repeat(59_246) }),
      filler(3),
      filler(4),
      makeMessage({ id: 'newest', role: 'assistant', contentText: '最终结论：超时定为 30s' }),
    ];
    const transcript = buildDigestTranscript(messages, { budgetChars: 6_000 });
    expect(transcript).toContain('最终结论：超时定为 30s');
    expect(transcript).toContain('第3条');
    expect(transcript).toContain('第4条');
    // Giant (>10k) truncated head+tail to the oversized cap instead of eating
    // the whole budget (v1 fit 1/44 messages in the worst real session).
    const giantLine = transcript.split('\n').find(line => line.includes('G'.repeat(100)))!;
    expect(giantLine.length).toBeLessThanOrEqual(4_000);
    expect(giantLine).toContain('中间省略');
    expect(transcript.length).toBeLessThanOrEqual(6_000);
  });

  it('always includes the first user message, deduped when already in window', () => {
    const short = [makeMessage({ id: 'u1', contentText: '帮我实现登录功能' }), filler(2)];
    const inWindow = buildDigestTranscript(short);
    expect(inWindow).toContain('【会话开场】');
    expect(inWindow.indexOf('帮我实现登录功能')).toBe(inWindow.lastIndexOf('帮我实现登录功能'));

    const long = [
      makeMessage({ id: 'u1', contentText: '本次任务：重构 digest 管线' }),
      ...Array.from({ length: 80 }, (_, i) => filler(i)),
    ];
    const outOfWindow = buildDigestTranscript(long, { recentLimit: 60 });
    expect(outOfWindow).toContain('【会话开场】');
    expect(outOfWindow).toContain('本次任务：重构 digest 管线');
    expect(outOfWindow.indexOf('本次任务')).toBe(outOfWindow.lastIndexOf('本次任务'));
  });

  it('back-fills the most recent file-write messages outside the recent window', () => {
    const messages = [
      makeMessage({ id: 'u1', contentText: '改造配置加载' }),
      makeMessage({
        id: 'early-edit',
        role: 'assistant',
        source: 'tool_request',
        contentText: '修改了 src/config.ts 的加载顺序',
        contentToolName: 'Edit',
      }),
      ...Array.from({ length: 70 }, (_, i) => filler(i)),
    ];
    const transcript = buildDigestTranscript(messages, { recentLimit: 60 });
    // 72 entries, recent window covers the last 60 — the Edit at index 1 is
    // far outside but must be pulled in as a file-write extra.
    expect(transcript).toContain('修改了 src/config.ts 的加载顺序');
    expect(transcript).toContain('工具：Edit');
    // …and it lands before the recent messages (chronological order).
    expect(transcript.indexOf('修改了 src/config.ts')).toBeLessThan(transcript.indexOf('第69条'));
  });

  it('caps file-write extras at the configured limit', () => {
    const messages = [
      makeMessage({ id: 'u1', contentText: '批量改文件' }),
      ...Array.from({ length: 20 }, (_, i) => makeMessage({
        id: `edit-${i}`,
        role: 'assistant',
        source: 'tool_request',
        contentText: `写入了 file-${String(i).padStart(2, '0')}.ts`,
        contentToolName: 'Write',
      })),
      ...Array.from({ length: 70 }, (_, i) => filler(i)),
    ];
    const transcript = buildDigestTranscript(messages, { recentLimit: 60, fileWriteExtraLimit: 10 });
    // Only the 10 newest writes (10..19) are back-filled; the oldest are not.
    expect(transcript).toContain('file-19.ts');
    expect(transcript).toContain('file-10.ts');
    expect(transcript).not.toContain('file-09.ts');
  });

  it('oversized messages contribute head and tail, not just the head', () => {
    const tailFact = '尾部事实：最终端口定为 8321';
    const messages = [
      makeMessage({ id: 'u1', contentText: '跑一个长任务' }),
      makeMessage({
        id: 'huge',
        role: 'assistant',
        contentText: '头'.repeat(12_000) + tailFact,
      }),
      filler(3),
    ];
    const transcript = buildDigestTranscript(messages, { budgetChars: 6_000 });
    expect(transcript).toContain(tailFact);
    expect(transcript).toContain('中间省略');
  });

  it('keeps the newest message even when the budget is nearly exhausted', () => {
    const messages = [
      makeMessage({ id: 'u1', contentText: '开始' }),
      ...Array.from({ length: 30 }, (_, i) => filler(i, 200)),
      makeMessage({ id: 'newest', role: 'assistant', contentText: '收尾结论必须保留' }),
    ];
    const transcript = buildDigestTranscript(messages, { budgetChars: 600 });
    expect(transcript).toContain('收尾结论必须保留');
  });

  it('skips empty messages and summarizes tool calls', () => {
    const messages = [
      makeMessage({ id: 'u1', contentText: '看看这个错误' }),
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
    // tool output is still capped at 200 chars inside a formatted message
    const toolLine = transcript.split('\n').find(line => line.includes('工具结果'))!;
    expect(toolLine.length).toBeLessThan(260);
  });

  it('respects the character budget across many mid-size messages', () => {
    const messages = [
      makeMessage({ id: 'u1', contentText: '任务开始' }),
      ...Array.from({ length: 50 }, (_, i) => filler(i, 300)),
    ];
    const transcript = buildDigestTranscript(messages, { budgetChars: 2_000 });
    // budget + slack for the always-included newest message (≤ 40 chars)
    expect(transcript.length).toBeLessThanOrEqual(2_000 + 40);
    expect(transcript).toContain('第49条');
  });
});

describe('formatDigestMessage', () => {
  it('prefixes the role and joins channels', () => {
    const out = formatDigestMessage(makeMessage({
      role: 'assistant',
      contentText: '正文',
      contentToolName: 'Read',
      contentToolOutput: '内容',
    }));
    expect(out.startsWith('AI：')).toBe(true);
    expect(out).toContain('正文');
    expect(out).toContain('工具：Read');
  });
});

// ---- Numeric Fact Extraction Tests -----------------------------------------

import {
  extractNumericFacts,
  formatNumericFactsBlock,
  scoreFactDensity,
} from '../src/digest/transcript.js';

describe('extractNumericFacts', () => {
  it('extracts semantic version numbers', () => {
    const facts = extractNumericFacts('升级到 v2.3.1 后解决了问题。也试过 1.0.0-beta.2');
    const versions = facts.filter(f => f.label === '版本').map(f => f.value);
    expect(versions).toContain('v2.3.1');
    expect(versions).toContain('1.0.0-beta.2');
  });

  it('extracts numbers with units', () => {
    const facts = extractNumericFacts('超时设为 30s，内存限制 512MB，压缩到 85%');
    const unitFacts = facts.filter(f => f.label === '数值+单位');
    expect(unitFacts.some(f => f.value.includes('30s'))).toBe(true);
    expect(unitFacts.some(f => f.value.includes('512MB'))).toBe(true);
    expect(unitFacts.some(f => f.value.includes('85%'))).toBe(true);
  });

  it('extracts port numbers in context', () => {
    const facts = extractNumericFacts('服务启动在 port 3000，调试端口 :9229');
    const ports = facts.filter(f => f.label === '端口').map(f => f.value);
    expect(ports.some(p => p.includes('3000'))).toBe(true);
    expect(ports.some(p => p.includes('9229'))).toBe(true);
  });

  it('extracts config parameters', () => {
    const facts = extractNumericFacts('timeout: 5000, max_retries=3, chunk_size: 64KB');
    const configs = facts.filter(f => f.label === '配置参数');
    expect(configs.some(f => f.value.includes('5000'))).toBe(true);
    expect(configs.some(f => f.value.includes('3'))).toBe(true);
  });

  it('skips long numeric IDs (10+ digits)', () => {
    const facts = extractNumericFacts('事务 ID 12345678901 和用户 ID 98765432101');
    // No facts should match 10+ digit "IDs".
    const longDigits = facts.filter(f => /\d{10,}/.test(f.value));
    expect(longDigits).toHaveLength(0);
  });

  it('deduplicates identical values', () => {
    const facts = extractNumericFacts('版本 v2.0.0 已发布。v2.0.0 是主要版本。');
    const versions = facts.filter(f => f.value === 'v2.0.0');
    expect(versions).toHaveLength(1);
  });

  it('formats a facts block from extracted facts', () => {
    const facts = extractNumericFacts('升级到 v2.3.1，超时 30s');
    const block = formatNumericFactsBlock(facts);
    expect(block).toContain('系统自动提取的数值事实');
    expect(block).toContain('v2.3.1');
    expect(block).toContain('30s');
  });

  it('returns empty string when no facts found', () => {
    expect(formatNumericFactsBlock([])).toBe('');
  });
});

describe('scoreFactDensity', () => {
  it('scores higher for messages with quoted strings and numbers', () => {
    const low = scoreFactDensity('用户：好的，我看看');
    const high = scoreFactDensity('AI：配置文件 "config.json" 中 timeout: 5000ms, retries=3');
    expect(high).toBeGreaterThan(low);
  });

  it('scores higher for messages with version/error keywords', () => {
    const low = scoreFactDensity('用户：你好');
    const high = scoreFactDensity('AI：版本 v2.0 修复了 migration 错误，breaking change 需要更新');
    expect(high).toBeGreaterThan(low);
  });

  it('prefers medium-length messages over very short or very long', () => {
    const tooShort = scoreFactDensity('短');
    const medium = scoreFactDensity('A'.repeat(500) + ' fix: deploy v2.0 breaking change timeout=30s');
    expect(medium).toBeGreaterThan(tooShort);
  });
});
