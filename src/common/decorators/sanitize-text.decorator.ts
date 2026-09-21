import { Transform } from 'class-transformer';
import sanitizeHtml from 'sanitize-html';

/**
 * Decorator para sanitizar texto libre usando sanitize-html en el pipe de validación (class-transformer).
 * Remueve cualquier etiqueta y atributo HTML para evitar ataques de XSS almacenado,
 * preservando texto normal, tildes, caracteres especiales y saltos de línea.
 */
export function SanitizeText() {
  return Transform(({ value }) =>
    typeof value === 'string'
      ? sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} })
      : value,
  );
}
