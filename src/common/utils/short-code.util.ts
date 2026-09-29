import * as crypto from 'crypto';

/**
 * Alfabeto alfanumérico sin caracteres ambiguos (excluye 0, O, 1, I, l).
 * 8 dígitos (2-9) + 24 letras mayúsculas (A-Z sin O ni I) = 32 caracteres.
 * Con 8 caracteres, existen 32^8 = 1.099.511.627.776 (~1.1 billones) combinaciones.
 */
export const UNAMBIGUOUS_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const DEFAULT_SHORT_CODE_LENGTH = 8;

/**
 * Genera un código corto aleatorio y seguro para enlaces breves.
 * Ejemplo resultante: "AB3F9K2P"
 */
export function generateShortCode(length: number = DEFAULT_SHORT_CODE_LENGTH): string {
  let result = '';
  const alphabetLength = UNAMBIGUOUS_ALPHABET.length;
  for (let i = 0; i < length; i++) {
    const randomIndex = crypto.randomInt(0, alphabetLength);
    result += UNAMBIGUOUS_ALPHABET[randomIndex];
  }
  return result;
}

/**
 * Normaliza un código corto (limpieza de espacios y mayúsculas) para búsquedas seguras.
 */
export function normalizeShortCode(code?: string | null): string {
  return (code || '').trim().toUpperCase();
}
