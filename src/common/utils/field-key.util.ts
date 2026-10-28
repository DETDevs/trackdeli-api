/**
 * Genera una clave normalizada para campos dinámicos a partir de su etiqueta.
 * - Minúsculas
 * - Sin acentos/tildes
 * - Reemplazo de caracteres especiales y espacios por guiones bajos (_)
 * - Sin guiones bajos duplicados ni en extremos
 * - Máximo 50 caracteres
 */
export function generateFieldKey(label: string): string {
  if (!label) return '';

  return label
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Quita tildes/marcas diacríticas
    .replace(/ñ/g, 'n')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 50);
}

/**
 * Normaliza una etiqueta de opción de campo tipo LIST para comparaciones y unicidad:
 * - Minúsculas
 * - Sin acentos/tildes ni marcas diacríticas
 * - Trim y espacios colapsados a uno solo
 * - Máximo 120 caracteres
 */
export function normalizeOptionLabel(label: string): string {
  if (!label) return '';
  return label
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
}

export function hasAccents(str: string): boolean {
  return /[áéíóúÁÉÍÓÚñÑ]/.test(str);
}

export function isProperCase(str: string): boolean {
  const trimmed = str.trim();
  if (!trimmed) return false;
  const startsUpper = /^[A-ZÁÉÍÓÚÑ]/.test(trimmed);
  const notAllUpper = trimmed !== trimmed.toUpperCase() && /[a-záéíóúñ]/.test(trimmed);
  return startsUpper && notAllUpper;
}

/**
 * Selecciona la mejor etiqueta escrita entre distintas variantes de un mismo valor:
 * (a) la variante con tildes
 * (b) la que empieza con mayúscula y no está toda en mayúsculas
 * (c) la más usada
 */
export function pickBestOptionLabel(variants: Array<{ label: string; count: number }>): string {
  if (!variants || variants.length === 0) return '';
  if (variants.length === 1) return variants[0].label;

  const sorted = [...variants].sort((a, b) => {
    // (a) Variante con tildes
    const aAcc = hasAccents(a.label);
    const bAcc = hasAccents(b.label);
    if (aAcc && !bAcc) return -1;
    if (!aAcc && bAcc) return 1;

    // (b) Empieza con mayúscula y no está toda en mayúsculas
    const aProp = isProperCase(a.label);
    const bProp = isProperCase(b.label);
    if (aProp && !bProp) return -1;
    if (!aProp && bProp) return 1;

    // (c) La más usada
    if (b.count !== a.count) {
      return b.count - a.count;
    }

    // Desempate: empieza con mayúscula
    const aUpper = /^[A-ZÁÉÍÓÚÑ]/.test(a.label);
    const bUpper = /^[A-ZÁÉÍÓÚÑ]/.test(b.label);
    if (aUpper && !bUpper) return -1;
    if (!aUpper && bUpper) return 1;

    return a.label.localeCompare(b.label);
  });

  return sorted[0].label;
}

