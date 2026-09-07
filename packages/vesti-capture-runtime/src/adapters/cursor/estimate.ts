/**
 * Character-based token estimate for Cursor sessions. Recent Cursor builds
 * write no real usage locally (bubble.tokenCount is all zeros; usage moved
 * server-side), so sessions would otherwise report a misleading hard 0.
 * Heuristic: ~4 ASCII chars/token, ~0.7 token per CJK char. Estimated
 * sessions are stamped with meta.token_estimated so downstream surfaces can
 * label them; per-message usage is never fabricated.
 */
export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x2e80 && code <= 0x9fff) || // CJK radicals..unified ideographs
      (code >= 0x3040 && code <= 0x30ff) || // kana
      (code >= 0xac00 && code <= 0xd7af) || // hangul
      (code >= 0xf900 && code <= 0xfaff) // compatibility ideographs
    ) {
      cjk++;
    } else {
      ascii++;
    }
  }
  return Math.round(ascii / 4 + cjk * 0.7);
}
