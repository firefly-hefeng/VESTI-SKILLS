import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function parseNdjson(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(
          `${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
}

function verify(directory) {
  const checksumPath = resolve(directory, 'SHA256SUMS');
  if (!existsSync(checksumPath)) throw new Error(`Missing ${checksumPath}`);
  const entries = readFileSync(checksumPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
      if (!match) throw new Error(`Invalid checksum line: ${line}`);
      return { expected: match[1], relativePath: match[2] };
    });

  let ndjsonRows = 0;
  for (const entry of entries) {
    const path = resolve(directory, entry.relativePath);
    if (sha256(path) !== entry.expected) {
      throw new Error(`Checksum mismatch: ${path}`);
    }
    if (path.endsWith('.json')) JSON.parse(readFileSync(path, 'utf8'));
    if (path.endsWith('.ndjson')) {
      const rows = parseNdjson(path);
      ndjsonRows += rows.length;
      if (rows.some(row => row.runId)) {
        const ids = rows.map(row => row.runId);
        if (new Set(ids).size !== ids.length) {
          throw new Error(`Duplicate runId in ${path}`);
        }
        if (rows.some(row => row.status !== 'completed' || row.error != null)) {
          throw new Error(`Incomplete or failed Agent run in ${path}`);
        }
      }
    }
  }

  const serialized = entries
    .map(entry => readFileSync(resolve(directory, entry.relativePath), 'utf8'))
    .join('\n');
  if (/C:[/\\]Users[/\\]|D:[/\\]nodejs/i.test(serialized)) {
    throw new Error(`Machine-specific path remains in ${directory}`);
  }
  return { directory, files: entries.length, ndjsonRows };
}

if (process.argv.length < 3) {
  throw new Error('Pass one or more canonical result directories');
}

for (const input of process.argv.slice(2)) {
  const result = verify(resolve(input));
  console.log(
    `${result.directory}: ${result.files} checksums verified, ${result.ndjsonRows} NDJSON rows`,
  );
}
