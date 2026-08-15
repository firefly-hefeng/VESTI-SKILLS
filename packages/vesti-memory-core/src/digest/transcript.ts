import { stripInjectedContextBlocks } from '../utils/injectedBlocks.js';
import type { SessionMessage } from '../types.js';

/**
 * Digest transcript window assembly (pure functions, unit-testable).
 *
 * v2 (bench C 2026-07-19 follow-up): the old window (last ≤60 messages,
 * 6000-char tail budget, no per-message cap) let one giant message eat the
 * whole budget — the worst real session fit 44 messages into 1 — and 48% of
 * extracted facts never reached the digest prompt. The v2 assembly keeps the
 * mandated mechanics but with parameters fixed from a policy sweep on the
 * real snapshot (scripts/bench/window-sweep.mjs):
 *  - blind-spot decomposition showed 81.6% of invisible facts sit in messages
 *    OLDER than the 60-message cutoff (only 8.3% are budget victims), so the
 *    recency limit is raised to a non-binding safety valve and the budget
 *    doubled to 12000;
 *  - a uniform per-message cap (e.g. 800) was measured WORSE than v1 (20.8%
 *    vs 51.8% visible) because facts concentrate deep inside long messages
 *    (fact offset p50 ≈ 1265 chars) — so normal messages are always kept
 *    whole and only OVERSIZED ones (>10k) are truncated, head+tail with an
 *    explicit elision mark, to min(OVERSIZED_MESSAGE_CAP, remaining budget);
 *  - the first user message (task framing) gets its own capped section;
 *  - the most recent file-write tool messages outside the recency valve are
 *    back-filled (file-state facts cluster there);
 *  - filling is newest-first, so budget pressure always drops the oldest
 *    context first; the newest message is always included (v1 guarantee).
 */

export const RECENT_MESSAGE_LIMIT = 500;
export const TRANSCRIPT_BUDGET_CHARS = 12_000;
export const FIRST_USER_MESSAGE_CHARS = 400;
export const OVERSIZED_MESSAGE_CAP_CHARS = 4_000;
export const FILE_WRITE_EXTRA_LIMIT = 10;
export const OVERSIZED_MESSAGE_CHARS = 10_000;
export const TOOL_OUTPUT_CHARS = 200;

/** Below this a window slot carries no usable content; skip and pass the
 * remaining budget on to newer messages. */
const MIN_SLOT_CHARS = 40;
const TRUNCATED_MARK = '……[截断]';
const elisionMark = (omitted: number) => `……[中间省略 ${omitted} 字符]……`;

/** Tool names that write files (real names from the bench snapshot:
 * Edit/Write dominate; _v2 variants come from kimi-code). Matched lowercase. */
const FILE_WRITE_TOOL_NAMES = new Set([
  'edit', 'multiedit', 'write', 'notebookedit',
  'edit_file', 'edit_file_v2', 'write_file', 'create_file', 'delete_file',
  'apply_patch', 'str_replace_editor', 'fswrite',
]);

export function isFileWriteTool(toolName?: string): boolean {
  return Boolean(toolName && FILE_WRITE_TOOL_NAMES.has(toolName.trim().toLowerCase()));
}

export function formatDigestMessage(message: SessionMessage): string {
  // User messages carry system-injected context (<environment_context>,
  // <timestamp>, <git-context>…) that is not the user's words — it crowds the
  // window and the LLM echoes it into one_liners. Strip it here; the stored
  // message record keeps the original.
  const contentText = message.role === 'user' && message.contentText
    ? stripInjectedContextBlocks(message.contentText)
    : message.contentText;
  const values = [
    contentText,
    message.contentToolName ? `工具：${message.contentToolName}` : undefined,
    message.contentToolOutput ? `工具结果：${message.contentToolOutput.slice(0, TOOL_OUTPUT_CHARS)}` : undefined,
    message.contentToolError ? `工具错误：${message.contentToolError.slice(0, TOOL_OUTPUT_CHARS)}` : undefined,
  ].filter((value): value is string => Boolean(value?.trim()));
  if (!values.length) return '';
  const role = message.role === 'user' ? '用户' : message.role === 'assistant' ? 'AI' : '系统';
  return `${role}：${values.join('；')}`;
}

/**
 * Fit `text` into `cap` chars. Normal overflow keeps the head and appends a
 * truncation mark; oversized originals (> OVERSIZED_MESSAGE_CHARS) keep head
 * AND tail with an elision mark — tails of long messages (command output,
 * pasted logs) often carry the final state.
 */
export function truncateForDigest(text: string, cap: number, oversized: boolean): string {
  if (text.length <= cap) return text;
  if (cap < MIN_SLOT_CHARS) return text.slice(0, cap);
  if (oversized && cap >= 120) {
    // Reserve ~20 chars for the elision mark (adjust once if the omitted
    // count needs more digits than estimated).
    const estimate = 20;
    let head = Math.ceil((cap - estimate) * 0.6);
    let tail = cap - estimate - head;
    const mark = elisionMark(text.length - head - tail);
    if (mark.length > estimate) head = Math.max(0, head - (mark.length - estimate));
    return text.slice(0, head) + mark + (tail > 0 ? text.slice(text.length - tail) : '');
  }
  return text.slice(0, cap - TRUNCATED_MARK.length) + TRUNCATED_MARK;
}

export interface DigestTranscriptOptions {
  budgetChars?: number;
  recentLimit?: number;
  oversizedCapChars?: number;
  fileWriteExtraLimit?: number;
  oversizedChars?: number;
}

interface FormattedEntry {
  message: SessionMessage;
  formatted: string;
  oversized: boolean;
}

export function buildDigestTranscript(
  messages: SessionMessage[],
  options: DigestTranscriptOptions = {},
): string {
  const budget = options.budgetChars ?? TRANSCRIPT_BUDGET_CHARS;
  const recentLimit = options.recentLimit ?? RECENT_MESSAGE_LIMIT;
  const oversizedCap = options.oversizedCapChars ?? OVERSIZED_MESSAGE_CAP_CHARS;
  const fileWriteExtraLimit = options.fileWriteExtraLimit ?? FILE_WRITE_EXTRA_LIMIT;
  const oversizedChars = options.oversizedChars ?? OVERSIZED_MESSAGE_CHARS;

  const entries: FormattedEntry[] = [];
  for (const message of messages) {
    const formatted = formatDigestMessage(message);
    if (formatted) entries.push({ message, formatted, oversized: formatted.length > oversizedChars });
  }
  if (!entries.length) return '';

  // Selection (positions into `entries`): the recent window, plus the most
  // recent file-write messages that fell outside it.
  const recentStart = Math.max(0, entries.length - recentLimit);
  const selected = new Set<number>();
  for (let i = recentStart; i < entries.length; i += 1) selected.add(i);
  let extras = 0;
  for (let i = recentStart - 1; i >= 0 && extras < fileWriteExtraLimit; i -= 1) {
    if (isFileWriteTool(entries[i].message.contentToolName)) {
      selected.add(i);
      extras += 1;
    }
  }

  // The first user message (task framing) gets its own capped section so it
  // survives even when the recent window is crowded out.
  let remaining = budget;
  const sections: string[] = [];
  const firstUserPos = entries.findIndex(
    entry => entry.message.role === 'user' && entry.message.contentText?.trim(),
  );
  if (firstUserPos !== -1) {
    const entry = entries[firstUserPos];
    const cap = Math.max(
      MIN_SLOT_CHARS,
      Math.min(FIRST_USER_MESSAGE_CHARS, Math.floor(budget / 4), entry.formatted.length),
    );
    const text = truncateForDigest(entry.formatted, cap, entry.oversized);
    const section = `【会话开场】${text}`;
    sections.push(section);
    remaining -= section.length + 1; // + the '\n' separator it will be joined with
    selected.delete(firstUserPos);
  }

  // Newest-first fill. Normal messages are kept whole (they carry the facts);
  // oversized ones are capped at min(oversizedCap, remainingBudget) with a
  // head+tail cut, so a single giant message can no longer starve the window.
  // Entries that no longer fit a useful slot are skipped oldest-first.
  const windowed = [...selected].sort((a, b) => b - a).map(i => entries[i]);
  const parts: string[] = [];
  windowed.forEach((entry, i) => {
    const isNewest = i === 0;
    let cap = entry.oversized ? Math.min(oversizedCap, remaining) : remaining;
    // The newest message is always included (mirrors the v1 guarantee).
    if (isNewest) cap = Math.max(cap, MIN_SLOT_CHARS);
    if (cap < MIN_SLOT_CHARS) return;
    const text = truncateForDigest(entry.formatted, cap, entry.oversized);
    parts.unshift(text);
    remaining -= text.length + 1; // + the '\n' separator
  });

  return [...sections, ...parts].join('\n');
}

// ---- Numeric/Value Fact Pre-Extraction (Digest V2) -------------------------
//
// Bench C showed 6.4% numerical fidelity in digest one-liners — numbers
// embedded in long messages are almost never correctly transcribed by the
// summarization LLM. The pre-extraction pass (no LLM, pure regex) scans the
// assembled transcript for high-signal numeric patterns and appends a
// structured block the digest agent can reference directly, turning the task
// from "discover and transcribe numbers" into "integrate provided values."
//
// Significance heuristic: skip 10+ digit numbers (IDs/timestamps), prefer
// numbers near technical keywords (version, threshold, port, config, timeout…).

const NUMERIC_SIGNAL_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Semantic version numbers: v1.2.3, 2.0.0-beta.1
  { pattern: /\b(v?\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9.]+)?)\b/g, label: '版本' },
  // Numbers with units (time, memory, percentage, pixels, etc.).
  // Trailing \b replaced with (?!\d) so % (a non-word char) still matches.
  { pattern: /\b(\d+(?:\.\d+)?\s*(?:ms|s|sec|min|hour|MB|GB|KB|TB|%|px|em|rem|rpm|bps|Hz|MHz|GHz))(?!\d)/gi, label: '数值+单位' },
  // Port numbers in context: :3000, port 8080
  { pattern: /(?:port|端口|:)\s*(\d{2,5})(?!\d|[.\-_/][\w.])/gi, label: '端口' },
  // Config values: key=value, key: value (numeric value).
  // Uses (?![a-z_]) instead of \b so compound keys (chunk_size, maxRetries) match.
  { pattern: /(?:timeout|limit|threshold|max|min|size|chunk|batch|pool|workers?|threads?|retries?|ttl|interval|delay|rate|cache|buffer)(?:_\w+)?\s*[:=]\s*(\d+(?:\.\d+)?(?:\s*[a-zA-Z]+)?)/gi, label: '配置参数' },
  // Commands with version output: --version, -v
  { pattern: /\b(node|npm|pnpm|yarn|python|go|rust|tsc|eslint|prettier)\s+(?:--version|-v|version)\b[:\s]*(\S+)/gi, label: '工具版本' },
  // File count / line count patterns
  { pattern: /\b(\d+)\s*(?:个?文件|files?|行|lines?|条|项|个|tests?|测试|cases?|用例)/gi, label: '数量统计' },
];

/** Minimum significance: skip pure numeric IDs (10+ digits) and single-digit
 * values that are rarely meaningful outside a specific context. */
const MIN_SIGNIFICANT_DIGITS = 2;
const MAX_ID_DIGITS = 9;

export interface NumericFact {
  value: string;
  label: string;
  /** The surrounding ~40 chars for context in the digest. */
  snippet: string;
}

/**
 * Scan the assembled digest transcript for numeric/semantic-value facts.
 * Returns a deduplicated list ordered by occurrence, max 24 items so the
 * block never dominates the transcript budget.
 */
export function extractNumericFacts(transcript: string): NumericFact[] {
  const facts: NumericFact[] = [];
  const seen = new Set<string>();

  for (const { pattern, label } of NUMERIC_SIGNAL_PATTERNS) {
    // Reset lastIndex for global regexps.
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(transcript)) !== null) {
      const rawValue = (match[1] || match[0]).trim();
      // Skip values that look like IDs/timestamps (very long digit runs).
      const digitCount = (rawValue.match(/\d/g) || []).length;
      if (digitCount > MAX_ID_DIGITS) continue;
      // Config params and ports: even single-digit values are significant
      // (e.g. retries=3, port 80). Other labels need ≥2 digits or a letter.
      const isInherentlySignificant = label === '配置参数' || label === '端口';
      if (!isInherentlySignificant && digitCount < MIN_SIGNIFICANT_DIGITS && !/[a-zA-Z]/.test(rawValue)) continue;
      // Deduplicate by normalized value + label.
      const normalKey = `${label}:${rawValue.toLowerCase().replace(/\s+/g, '')}`;
      if (seen.has(normalKey)) continue;
      seen.add(normalKey);

      const matchStart = Math.max(0, match.index - 20);
      const matchEnd = Math.min(transcript.length, match.index + rawValue.length + 20);
      const snippet = transcript.slice(matchStart, matchEnd).replace(/\s+/g, ' ').trim();

      facts.push({ value: rawValue, label, snippet: `…${snippet}…` });
      if (facts.length >= 24) break;
    }
    if (facts.length >= 24) break;
  }

  return facts;
}

/**
 * Format extracted numeric facts into a transcript-ready block the digest
 * agent can reference. Returns empty string when no facts were found.
 */
export function formatNumericFactsBlock(facts: NumericFact[]): string {
  if (facts.length === 0) return '';
  const lines = ['## 系统自动提取的数值事实（请保留原值并融入摘要）'];
  for (const fact of facts) {
    lines.push(`- [${fact.label}] ${fact.value}  (${fact.snippet})`);
  }
  return lines.join('\n');
}

// ---- Fact-Aware Backfill Scoring (Digest V2) -------------------------------

const FACT_SIGNAL_KEYWORDS = [
  'version', 'v\d+', 'port', 'timeout', 'threshold', 'config',
  'error', 'fail', 'success', 'pass', 'merge', 'deploy', 'release',
  'fix', 'breaking', 'deprecat', 'migrat',
];

/**
 * Score a formatted message entry for fact density. Messages with high
 * scores contain version numbers, error messages, configuration values,
 * or structured output — the kinds of content that carry digest facts.
 * Used to backfill high-density old messages beyond the recency limit.
 */
export function scoreFactDensity(formatted: string): number {
  let score = 0;
  const lower = formatted.toLowerCase();

  // Double-quoted strings often carry literal values (paths, config keys).
  const quotedCount = (lower.match(/"[^"]{3,}"/g) || []).length;
  score += quotedCount * 2;

  // Technical signal keywords.
  for (const kw of FACT_SIGNAL_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`, 'gi');
    const hits = (lower.match(re) || []).length;
    score += hits;
  }

  // Numeric patterns (highly correlated with digest facts).
  const numericCount = (lower.match(/\d+(?:\.\d+)?\s*(?:ms|s|MB|GB|%|px)?/g) || []).length;
  score += numericCount;

  // Non-code length: very short or very long messages are less useful.
  if (formatted.length > 200 && formatted.length < 4000) score += 3;
  else if (formatted.length >= 4000) score += 1; // oversized; head+tail in truncation

  return score;
}
