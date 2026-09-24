/**
 * Normaliza un nombre a un slug estándar:
 * - Minúsculas
 * - Sin tildes ni acentos (NFD normalization)
 * - Espacios y caracteres no alfanuméricos reemplazados por guiones simples
 * - Sin guiones al inicio o al final
 * - Fallback a 'negocio' si el resultado queda vacío
 */
export function slugify(text: string): string {
  if (!text) return 'negocio';
  const clean = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean || 'negocio';
}

/**
 * Regex para validar el formato de slug:
 * Solo minúsculas, dígitos y guiones simples entre palabras (sin guiones dobles ni extremos).
 */
export const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Verifica si un string tiene formato de UUID v4.
 */
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
