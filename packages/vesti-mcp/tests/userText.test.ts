import { describe, expect, it } from 'vitest';

import {
  looksLikeInjectedContextPrefix,
  sanitizeCapturedText,
} from '../src/injectedBlocks.js';
import {
  looksLikeCodexInjectedPrefix,
  sanitizeCodexUserText,
} from '../src/codexUserText.js';

describe('captured user-text sanitization', () => {
  it('removes shared boundary envelopes and unwraps user_query', () => {
    expect(sanitizeCapturedText(
      '<recommended_plugins><plugin>noise</plugin></recommended_plugins>\n'
      + '<user_query>Keep the actual request.</user_query>\n'
      + '<ide_opened_file path="secret.ts"/>',
    )).toBe('Keep the actual request.');
    expect(sanitizeCapturedText('<turn_aborted>cancelled</turn_aborted>')).toBe('');
    expect(looksLikeInjectedContextPrefix('<recommended_plugins>')).toBe(true);
    expect(looksLikeInjectedContextPrefix('<ide_opened_file path="x"/>')).toBe(true);
  });

  it('extracts Codex Files-mentioned requests and drops transport images', () => {
    const text = [
      '# Files mentioned by the user:',
      '',
      '- form.png',
      '',
      '## My request for Codex:',
      'Reuse the saved address in this form.',
      '<image src="transport"/>',
    ].join('\n');
    expect(sanitizeCodexUserText(text)).toBe('Reuse the saved address in this form.');
    expect(looksLikeCodexInjectedPrefix(text)).toBe(true);
  });

  it('drops Codex system-only markers without erasing inline examples', () => {
    expect(sanitizeCodexUserText('# AGENTS.md instructions for C:/repo\nDo X')).toBe('');
    expect(sanitizeCodexUserText('<ide_opened_file>src/a.ts</ide_opened_file>')).toBe('');
    expect(sanitizeCodexUserText('Explain <turn_aborted/> as literal markup.'))
      .toBe('Explain <turn_aborted/> as literal markup.');
  });
});
