const PATH_JSON_KEYS = new Set([
  'path',
  'file',
  'filepath',
  'file_path',
  'filename',
  'target_file',
  'notebook_path',
  'abs_path',
  'absolute_path',
]);

function looksLikeFilePath(candidate: string): boolean {
  if (candidate.length < 3 || !candidate.includes('/')) return false;
  const base = candidate.slice(candidate.lastIndexOf('/') + 1);
  if (!/^[\p{L}\p{N}_.@+-]+\.[\p{L}\p{N}]{1,10}$/u.test(base)) return false;
  if (/^\d+\.\d+/.test(base)) return false;
  if (/^https?:/i.test(candidate)) return false;
  return true;
}

/** Pull plausible file paths out of a captured tool input summary. */
export function extractFilePaths(text: string): string[] {
  if (!text) return [];
  const cleanedText = text.replace(/https?:\/\/\S+/gi, ' ');
  const out = new Set<string>();
  const add = (value: string) => {
    const candidate = value.replace(/\\/g, '/').replace(/[.,;:)\]]+$/, '');
    if (looksLikeFilePath(candidate)) out.add(candidate);
  };
  const pattern =
    /(?:[A-Za-z]:[\\/]|~?[\\/]|\.{1,2}[\\/])?(?:[\p{L}\p{N}_.@+-]+[\\/])+[\p{L}\p{N}_.@+-]+\.[\p{L}\p{N}]{1,10}/gu;
  if (cleanedText.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(cleanedText) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== 'string') continue;
        if (PATH_JSON_KEYS.has(key.toLowerCase())) {
          add(value);
        } else if (key.toLowerCase() === 'command') {
          for (const match of value.matchAll(pattern)) add(match[0]);
        }
      }
      return [...out];
    } catch {
      // Not JSON; use the free-text extractor below.
    }
  }
  for (const match of cleanedText.matchAll(pattern)) add(match[0]);
  return [...out];
}

export function parseKeyFiles(text: string | null | undefined): string[] {
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

export function queryTokens(query: string): string[] {
  return [...new Set(
    query
      .split(/[\s,，、/\\:：*?"'<>|]+/)
      .map(token => token.replace(/[%_]/g, '').trim())
      .filter(token => token.length >= 2),
  )].slice(0, 4);
}
