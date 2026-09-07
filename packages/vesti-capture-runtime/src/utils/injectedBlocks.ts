/**
 * Strip system-injected context blocks from message text.
 *
 * Several agents prepend machine-generated context to user messages:
 * - Codex wraps environment info in `<environment_context>…</environment_context>`
 *   (and instructions in `<user_instructions>…</user_instructions>`)
 * - Kimi Code prefixes prompts with a self-closing `<git-context …/>` line
 * - Cursor agent transcripts prefix user lines with `<timestamp>…</timestamp>`
 *   and `<user_info>…</user_info>`, append `<system_notification>` /
 *   `<system_reminder>` blocks, and wrap the actual prompt in
 *   `<user_query>…</user_query>` (the wrapper tags go, the content stays)
 *
 * Only complete blocks at message boundaries are removed. This keeps literal
 * XML examples in ordinary prose/code intact while filtering the envelopes
 * agents add before or after the user's words.
 */

const PAIRED_INJECTED_TAGS = [
  'recommended_plugins',
  'environment_context',
  'user_instructions',
  'git-context',
  'timestamp',
  'user_info',
  'system_notification',
  'system_reminder',
  'turn_aborted',
  'ide_opened_file',
] as const;

const SELF_CLOSING_INJECTED_TAGS = [
  'git-context',
  'turn_aborted',
  'ide_opened_file',
] as const;

const INJECTED_BLOCK_SOURCES = [
  ...PAIRED_INJECTED_TAGS.map(tag => `<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`),
  ...SELF_CLOSING_INJECTED_TAGS.map(tag => `<${tag}\\b[^>]*\\/>`),
];

const INJECTED_PREFIX_TAGS = [...PAIRED_INJECTED_TAGS, 'user_query'] as const;
const INJECTED_PREFIX_PATTERN = new RegExp(
  `^\\s*<(?:${INJECTED_PREFIX_TAGS.join('|')})\\b`,
  'i',
);

function removeBoundaryBlocks(text: string): string {
  let result = text;
  let previous: string;
  do {
    previous = result;
    for (const source of INJECTED_BLOCK_SOURCES) {
      result = result
        .replace(new RegExp(`^\\s*(?:${source})`, 'i'), '')
        .replace(new RegExp(`(?:${source})\\s*$`, 'i'), '');
    }
  } while (result !== previous);
  return result;
}

/** Remove system envelopes while preserving the user's whitespace/Markdown. */
export function sanitizeCapturedText(text: string): string {
  let result = removeBoundaryBlocks(text);
  const userQuery = result.match(/^\s*<user_query\b[^>]*>([\s\S]*?)<\/user_query>\s*$/i);
  if (userQuery) result = userQuery[1];
  return result.trim();
}

/** Detect an injected tag whose stored title was truncated before its close tag. */
export function looksLikeInjectedContextPrefix(text: string): boolean {
  return INJECTED_PREFIX_PATTERN.test(text);
}

/** Backward-compatible name used by title, summary and renderer call sites. */
export function stripInjectedContextBlocks(text: string): string {
  return sanitizeCapturedText(text);
}
