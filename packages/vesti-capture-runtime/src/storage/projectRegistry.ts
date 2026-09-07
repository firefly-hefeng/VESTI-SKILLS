/**
 * Project Registry derivation
 * Deterministic project_key for CLI sessions: the sync pipeline groups
 * sessions into projects by normalized project_path (falling back to the
 * git remote, then 'unknown'). Pure functions shared by the storage layer
 * (project_registry upserts), the tree index and the main-process digest
 * pipeline so every consumer derives the exact same key.
 */

import { createHash } from 'node:crypto';

export interface ProjectKeyInput {
  platform: string;
  host: string;
  projectPath?: string;
  gitRemote?: string;
}

/**
 * Normalize a project path for stable keying: forward slashes, no duplicate
 * or trailing separators, lowercased Windows drive letter. Case is otherwise
 * preserved (POSIX paths are case-sensitive).
 */
export function normalizeProjectPath(projectPath: string): string {
  let value = projectPath.trim().replace(/\\/g, '/');
  value = value.replace(/\/{2,}/g, '/');
  if (value.length > 1) value = value.replace(/\/+$/, '');
  if (/^[A-Z]:\//.test(value)) value = value[0].toLowerCase() + value.slice(1);
  return value === '/' ? '' : value;
}

/** Normalize a git remote into a stable "host/owner/repo" style basis. */
export function normalizeGitRemote(gitRemote: string): string {
  let value = gitRemote.trim().replace(/\\/g, '/');
  value = value.replace(/\/+$/, '').replace(/\.git$/i, '');
  return value;
}

/**
 * The path-like basis a project is keyed on: normalized project_path, else
 * the normalized git remote, else 'unknown'.
 */
export function projectBasis(input: Pick<ProjectKeyInput, 'projectPath' | 'gitRemote'>): string {
  const path = normalizeProjectPath(input.projectPath ?? '');
  if (path) return path;
  const remote = normalizeGitRemote(input.gitRemote ?? '');
  if (remote) return remote;
  return 'unknown';
}

/** Deterministic short key: platform + host + normalized basis, hashed. */
export function deriveProjectKey(input: ProjectKeyInput): string {
  const basis = projectBasis(input);
  const hash = createHash('sha256')
    .update(`${input.platform}|${input.host}|${basis}`)
    .digest('hex')
    .slice(0, 16);
  return `cli_${hash}`;
}

/** Human label for a keyed project: basename of the basis. */
export function projectLabel(basis: string): string {
  if (!basis || basis === 'unknown') return 'unknown';
  const segments = basis.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? 'unknown';
}
