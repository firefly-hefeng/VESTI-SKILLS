import { sanitizeCodexUserText } from './codexUserText.js';
import { sanitizeCapturedText } from './injectedBlocks.js';

/** Apply transport-envelope cleanup using the capture platform's rules. */
export function sanitizePlatformUserText(text: string, platform?: string): string {
  return platform?.toLowerCase().startsWith('codex')
    ? sanitizeCodexUserText(text)
    : sanitizeCapturedText(text);
}
