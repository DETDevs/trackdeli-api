export const INTERNAL_BARCODE_PREFIX = '20';
export const MAX_INTERNAL_BARCODE_SEQUENCE = 9_999_999_999n;

/**
 * Calcula el dígito de control estándar EAN-13 a partir de los primeros 12 dígitos.
 * Regla GS1: posiciones impares (índice 0, 2, 4, 6, 8, 10) × 1;
 * posiciones pares (índice 1, 3, 5, 7, 9, 11) × 3;
 * dígito = (10 - (suma % 10)) % 10.
 */
export function calculateEan13CheckDigit(first12Digits: string): number {
  if (!/^\d{12}$/.test(first12Digits)) {
    throw new Error(`Se esperaban exactamente 12 dígitos numéricos para EAN-13, se recibió: "${first12Digits}"`);
  }

  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = first12Digits.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? digit : digit * 3;
  }

  return (10 - (sum % 10)) % 10;
}

/**
 * Construye un código EAN-13 de uso interno con prefijo "20" + 10 dígitos de secuencia + dígito de control.
 */
export function buildInternalEan13(sequenceNumber: bigint | number): string {
  const seq = typeof sequenceNumber === 'bigint' ? sequenceNumber : BigInt(sequenceNumber);
  if (seq < 1n || seq > MAX_INTERNAL_BARCODE_SEQUENCE) {
    throw new Error(`Número de secuencia fuera de rango EAN-13 interno: ${seq.toString()}`);
  }

  const body = seq.toString().padStart(10, '0');
  const first12 = `${INTERNAL_BARCODE_PREFIX}${body}`;
  const checkDigit = calculateEan13CheckDigit(first12);
  return `${first12}${checkDigit}`;
}

/**
 * Verifica si una cadena es un EAN-13 válido de 13 dígitos con dígito de control correcto.
 */
export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) {
    return false;
  }
  const expected = calculateEan13CheckDigit(code.slice(0, 12));
  return Number(code[12]) === expected;
}
