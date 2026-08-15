import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function filesUnder(directory) {
  const files = [];
  const visit = path => {
    for (const name of readdirSync(path).sort()) {
      const child = resolve(path, name);
      if (statSync(child).isDirectory()) visit(child);
      else if (name !== 'SHA256SUMS') files.push(child);
    }
  };
  visit(directory);
  return files;
}

if (process.argv.length !== 3) {
  throw new Error('Usage: node write-result-checksums.mjs <result-directory>');
}

const directory = resolve(process.argv[2]);
const lines = filesUnder(directory).map(path => (
  `${sha256(path)}  ${relative(directory, path).replaceAll('\\', '/')}`
));
writeFileSync(resolve(directory, 'SHA256SUMS'), `${lines.join('\n')}\n`);
