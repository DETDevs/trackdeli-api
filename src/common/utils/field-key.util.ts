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
