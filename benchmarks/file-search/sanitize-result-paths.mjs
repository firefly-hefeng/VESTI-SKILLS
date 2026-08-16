import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = resolve(HERE, '..', '..');
const APP_ROOTS = [
  resolve(SKILLS_ROOT, '..', 'VESTI-APP'),
  process.env.VESTI_APP_ROOT ? resolve(process.env.VESTI_APP_ROOT) : null,
].filter(Boolean);

function variants(path) {
  return [
    path.replaceAll('\\', '/'),
    path.replaceAll('/', '\\'),
  ];
}

function replaceAll(value, search, replacement) {
  return value.split(search).join(replacement);
}

function sanitizeString(value) {
  let sanitized = value;
  for (const root of variants(SKILLS_ROOT)) {
    sanitized = replaceAll(sanitized, root, '<VESTI_SKILLS_ROOT>');
  }
  for (const appRoot of APP_ROOTS) {
    for (const root of variants(appRoot)) {
      sanitized = replaceAll(sanitized, root, '<VESTI_APP_ROOT>');
    }
  }
  return sanitized;
}

function sanitize(value, key = '') {
  if (key === 'codexCommand' && Array.isArray(value)) {
    return ['<NODE_EXECUTABLE>', '<CODEX_CLI_ENTRY>'];
  }
  if (key === 'stderr' && typeof value === 'string' && value.length > 0) {
    return '<NON_FATAL_RUNTIME_LOG_REDACTED>';
  }
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.map(item => sanitize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitize(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

function sanitizeJson(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, `${JSON.stringify(sanitize(parsed), null, 2)}\n`);
}

function sanitizeNdjson(path) {
  const rows = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return sanitize(JSON.parse(line));
      } catch (error) {
        throw new Error(
          `${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  writeFileSync(path, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
}

if (process.argv.length < 3) {
  throw new Error('Pass one or more JSON or NDJSON result files');
}

for (const input of process.argv.slice(2)) {
  const path = resolve(input);
  if (extname(path) === '.ndjson') sanitizeNdjson(path);
  else sanitizeJson(path);
}
