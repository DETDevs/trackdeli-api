/**
 * Normaliza una placa de vehículo eliminando espacios, guiones, barras, puntos y convirtiendo a mayúsculas.
 * Ejemplos:
 * " M-123 456 " -> "M123456"
 * "m 55214" -> "M55214"
 */
export function normalizePlate(plate: string): string {
  if (!plate) return '';
  return plate
    .replace(/[\s\-_./]/g, '')
    .toUpperCase()
    .trim();
}
