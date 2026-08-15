/**
 * Digest prompt + payload parsing (P1.5).
 *
 * Ported from VESTI-APP src/main/agentPrompts.ts ('digest' agent kind). The
 * app wires prompts through a registry keyed by agent kind and derives the
 * language affix from user settings; this package keeps the prompt text
 * byte-identical but takes the language affix as a plain option, so no
 * settings service is needed.
 *
 * Bump DIGEST_VERSION in digest/DigestService.ts whenever the prompt
 * structure changes so stale digests get regenerated.
 */

export interface DigestPayload {
  one_liner: string;
  key_topics: string[];
  key_files: string[];
  decisions: string[];
  open_questions: string[];
}

export interface DigestChatMessage {
  role: 'system' | 'user';
  content: string;
}

/**
 * Language affixes mirrored from the app's promptAffixes() — keyed by the
 * app's outputLanguage codes so callers can pass settings through unchanged.
 */
export const DIGEST_LANGUAGE_AFFIXES: Record<string, string> = {
  'zh-CN': '使用清晰、简洁的中文 Markdown。',
  'en-US': 'Respond in clear English Markdown.',
  'ja-JP': '明確で簡潔な日本語の Markdown で回答してください。',
  'ko-KR': '명확하고 간결한 한국어 Markdown으로 답변하세요.',
};

/** Build the digest prompt messages. `languageAffix` defaults to zh-CN. */
export function buildDigestPrompt(
  transcript: string,
  options: { languageAffix?: string } = {},
): DigestChatMessage[] {
  const language = options.languageAffix ?? DIGEST_LANGUAGE_AFFIXES['zh-CN'];
  return [
    {
      role: 'system',
      content: `你是 Vesti 的会话索引助手。只依据提供的会话内容，输出严格 JSON（不要 Markdown 代码围栏、不要任何额外文字）。${language}`,
    },
    {
      role: 'user',
      content: [
        '请为下面的会话生成索引摘要，内容字段使用设置中指定的输出语言，输出一个 JSON 对象，字段如下：',
        '{"one_liner": "一句话概括会话做了什么、结果如何（50 字以内）", "key_topics": ["关键主题，至多 6 个"], "key_files": ["涉及的关键文件路径，至多 6 个"], "decisions": ["已做出的决定，至多 6 条"], "open_questions": ["未解决的问题，至多 6 条"]}',
        '硬性规则：',
        '- one_liner 概括实际完成的工作与结论（如「修复了 X 的 Y 问题」「调研了 Z，结论是…」），不要复述用户的原始提问，不要以「用户要求」「请」开头。',
        '- one_liner、key_topics 和 decisions 中涉及具体数值（版本号、配置值、端口号、日期、数量、金额、时长、阈值等）时，必须原样保留数值与单位，不得概括化。反例（禁止）：把「超时时间定为 30s」写成「调整了超时参数」；把「升级到 v2.5.0」写成「升级了版本」；把「预算 1500 元」写成「讨论了预算」。正确写法：「超时时间定为 30s」「升级到 v2.5.0」「预算定为 1500 元」。',
        '- key_files 保留完整文件路径，不要只写目录名或框架名。',
        '没有内容的字段输出空数组。只输出 JSON 本身。',
        '',
        transcript,
      ].join('\n'),
    },
  ];
}

function asStringList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

export function parseDigestPayload(raw: string): DigestPayload {
  // Tolerate Markdown code fences around the JSON object.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('digest 输出不是 JSON');
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  if (typeof parsed.one_liner !== 'string' || !parsed.one_liner.trim()) {
    throw new Error('digest 输出缺少 one_liner');
  }
  return {
    one_liner: parsed.one_liner.trim().slice(0, 200),
    key_topics: asStringList(parsed.key_topics, 8),
    key_files: asStringList(parsed.key_files, 8),
    decisions: asStringList(parsed.decisions, 8),
    open_questions: asStringList(parsed.open_questions, 8),
  };
}
