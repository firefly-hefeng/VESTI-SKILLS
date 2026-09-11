import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('ships the same memory instructions through the installer and the skill repository', async () => {
  const source = await readFile(new URL('../../../skills/vesti-memory/SKILL.md', import.meta.url), 'utf8');
  const bundled = await readFile(new URL('../assets/vesti-memory/SKILL.md', import.meta.url), 'utf8');
  expect(bundled.replace(/\r\n/g, '\n')).toBe(source.replace(/\r\n/g, '\n'));
});
