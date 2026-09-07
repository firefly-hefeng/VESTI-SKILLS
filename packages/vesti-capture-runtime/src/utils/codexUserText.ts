import { sanitizeCapturedText } from './injectedBlocks.js';

const CODEX_SYSTEM_ONLY_USER_MESSAGES: RegExp[] = [
  /^# AGENTS\.md instructions for\b[\s\S]*$/i,
  /^<turn_aborted\b[^>]*>[\s\S]*?<\/turn_aborted>$/i,
  /^<turn_aborted\b[^>]*\/>$/i,
  /^<ide_opened_file\b[^>]*>[\s\S]*?<\/ide_opened_file>$/i,
  /^<ide_opened_file\b[^>]*\/>$/i,
];

const CODEX_INJECTED_PREFIX = /^(?:# AGENTS\.md instructions for\b|# Files (?:mentioned|pasted) by the user:|<turn_aborted\b|<ide_opened_file\b)/i;

/** Remove Codex-only transport metadata after applying shared envelope rules. */
export function sanitizeCodexUserText(text: string): string {
  let result = sanitizeCapturedText(text);
  if (/^# Files (?:mentioned|pasted) by the user:/i.test(result)) {
    const request = result.match(
      /(?:^|\r?\n)## My request(?: for Codex)?:\s*\r?\n([\s\S]*)$/i,
    );
    if (request) {
      result = request[1]
        .replace(/\s*<image\b[^>]*>[\s\S]*?<\/image>\s*$/i, '')
        .replace(/\s*<image\b[^>]*\/>\s*$/i, '')
        .trim();
    }
  }
  return CODEX_SYSTEM_ONLY_USER_MESSAGES.some(pattern => pattern.test(result))
    ? ''
    : result;
}

export function looksLikeCodexInjectedPrefix(text: string): boolean {
  return CODEX_INJECTED_PREFIX.test(text);
}
