import path from 'node:path';

const MINIOG_ROOT = 'miniog';

/**
 * Convert a free-form name into a vault-safe slug. Lowercases, replaces
 * non-alphanumerics with hyphens, collapses runs, and trims leading/trailing
 * hyphens. Falls back to `unknown` so we never produce an empty filename.
 */
export function slugify(input: string | null | undefined): string {
  const raw = (input ?? '').trim().toLowerCase();
  if (!raw) return 'unknown';
  const cleaned = raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return cleaned || 'unknown';
}

/** YYYY-MM-DD in UTC. */
export function isoDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function userNotePath(vaultRoot: string, userSlug: string): string {
  return path.join(vaultRoot, MINIOG_ROOT, 'users', `${userSlug}.md`);
}

export function projectNotePath(vaultRoot: string, repo: string): string {
  return path.join(vaultRoot, MINIOG_ROOT, 'projects', `${slugify(repo)}.md`);
}

export function dailyNotePath(vaultRoot: string, date: string): string {
  return path.join(vaultRoot, MINIOG_ROOT, 'daily', `${date}.md`);
}

export function threadNotePath(vaultRoot: string, threadSlug: string): string {
  return path.join(vaultRoot, MINIOG_ROOT, 'threads', `${threadSlug}.md`);
}

export function metaNotePath(vaultRoot: string): string {
  return path.join(vaultRoot, MINIOG_ROOT, '_meta.md');
}
