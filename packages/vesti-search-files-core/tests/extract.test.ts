import { describe, expect, it } from 'vitest';

import { extractFilePaths, parseKeyFiles, queryTokens } from '../src/index.js';

describe('extractFilePaths', () => {
  it('reads path-named JSON keys directly', () => {
    expect(extractFilePaths('{"file_path": "src/a/b.ts", "content": "x = t.text"}')).toEqual([
      'src/a/b.ts',
    ]);
  });

  it('scans shell commands but skips content-ish values', () => {
    expect(extractFilePaths('{"command": "cat ./docs/readme.md && grep t.text"}')).toEqual([
      './docs/readme.md',
    ]);
  });

  it('falls back to the path regex for free text', () => {
    expect(extractFilePaths('edited C:/work/vesti/package.json, done')).toEqual([
      'C:/work/vesti/package.json',
    ]);
  });

  it('rejects member-access fragments, URLs and bare names', () => {
    expect(extractFilePaths('see https://example.com/a.png and EXPERTS.map or notes.txt')).toEqual([]);
  });
});

describe('query parsing', () => {
  it('parses key files defensively', () => {
    expect(parseKeyFiles('["src/a.ts", 3, null]')).toEqual(['src/a.ts']);
    expect(parseKeyFiles('not-json')).toEqual([]);
  });

  it('deduplicates useful name tokens without discarding later rare terms', () => {
    expect(queryTokens('oauth oauth auth.ts login callback extra')).toEqual([
      'oauth',
      'auth.ts',
      'login',
      'callback',
      'extra',
    ]);
  });

  it('filters short English stop words but preserves two-character CJK terms', () => {
    expect(queryTokens('采集 增量 in skills project files')).toEqual([
      '采集',
      '增量',
      'skills',
    ]);
  });
});
