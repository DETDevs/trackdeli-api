/**
 * Utilidades para parsing y comparación de versiones semver.
 * Se ignoran sufijos como -beta, -alpha o +build para comparar
 * la versión base numérica (major.minor.patch).
 */

export function cleanSemver(version: string): string {
  if (!version || typeof version !== 'string') return '';
  return version
    .trim()
    .replace(/^[vV]/, '')
    .split(/[-+]/)[0]
    .trim();
}

export function isValidSemver(version: string): boolean {
  if (!version || typeof version !== 'string') return false;
  const clean = cleanSemver(version);
  if (!clean) return false;
  const parts = clean.split('.');
  if (parts.length < 1 || parts.length > 3) return false;
  return parts.every((p) => /^\d+$/.test(p));
}

export function parseSemver(version: string): [number, number, number] | null {
  if (!version || typeof version !== 'string') return null;
  const clean = cleanSemver(version);
  if (!clean) return null;
  const parts = clean.split('.');
  if (parts.length === 0 || parts.length > 3) return null;

  const major = parseInt(parts[0], 10);
  const minor = parts.length > 1 ? parseInt(parts[1], 10) : 0;
  const patch = parts.length > 2 ? parseInt(parts[2], 10) : 0;

  if (isNaN(major) || isNaN(minor) || isNaN(patch)) return null;
  return [major, minor, patch];
}

/**
 * Retorna:
 *  > 0 si v1 > v2
 *  < 0 si v1 < v2
 *  = 0 si v1 == v2
 */
export function compareSemver(v1: string, v2: string): number {
  const p1 = parseSemver(v1);
  const p2 = parseSemver(v2);

  if (!p1 && !p2) return 0;
  if (!p1) return -1;
  if (!p2) return 1;

  if (p1[0] !== p2[0]) return p1[0] - p2[0];
  if (p1[1] !== p2[1]) return p1[1] - p2[1];
  return p1[2] - p2[2];
}
