import { BadRequestException } from '@nestjs/common';

export const ALLOWED_PRODUCT_UNITS = ['UND', 'LB', 'KG', 'ONZ', 'GR', 'LT', 'ML', 'GAL', 'MT', 'YD'] as const;
export type ProductUnit = string;

export interface DefaultUnitSeed {
  code: string;
  name: string;
  allowsDecimals: boolean;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
}

export const DEFAULT_SYSTEM_UNITS: DefaultUnitSeed[] = [
  { code: 'UND', name: 'Unidad', allowsDecimals: false, isSystem: true, isActive: true, sortOrder: 1 },
  { code: 'LB', name: 'Libra', allowsDecimals: true, isSystem: true, isActive: true, sortOrder: 2 },
  { code: 'KG', name: 'Kilo', allowsDecimals: true, isSystem: true, isActive: true, sortOrder: 3 },
  { code: 'ONZ', name: 'Onza', allowsDecimals: true, isSystem: true, isActive: true, sortOrder: 4 },
  { code: 'GR', name: 'Gramo', allowsDecimals: true, isSystem: true, isActive: true, sortOrder: 5 },
  { code: 'LT', name: 'Litro', allowsDecimals: true, isSystem: true, isActive: true, sortOrder: 6 },
  { code: 'ML', name: 'Mililitro', allowsDecimals: true, isSystem: true, isActive: true, sortOrder: 7 },
  { code: 'GAL', name: 'Galón', allowsDecimals: true, isSystem: true, isActive: true, sortOrder: 8 },
  { code: 'MT', name: 'Metro', allowsDecimals: true, isSystem: true, isActive: true, sortOrder: 9 },
  { code: 'YD', name: 'Yarda', allowsDecimals: true, isSystem: true, isActive: true, sortOrder: 10 },
];

export function round3(val: number): number {
  return Math.round((val + Number.EPSILON) * 1000) / 1000;
}

export function round2(val: number): number {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

/**
 * Valida que la cantidad sea válida según la unidad de medida del producto:
 * - Si allowsDecimals === false (o fallback UND sin allowsDecimals definido): debe ser entero estricto
 *   (salvo allowFractions=true para cobros divididos de cuentas).
 * - Si allowsDecimals === true (o unidad fraccionable): acepta decimales hasta 3 posiciones (mínimo 0.001).
 */
export function validateProductQuantity(
  unit: string | null | undefined,
  quantity: number,
  productName?: string,
  allowFractions = false,
  allowsDecimals?: boolean,
): number {
  const normalizedUnit = (unit || 'UND').trim().toUpperCase();
  const numQty = Number(quantity);

  if (!Number.isFinite(numQty) || numQty < 0) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      code: 'INVALID_QUANTITY',
      message: `Cantidad inválida (${quantity}) para el producto "${productName || 'sin nombre'}".`,
    });
  }

  const unitAllowsDecimals =
    allowsDecimals !== undefined ? Boolean(allowsDecimals) : normalizedUnit !== 'UND';

  if (!unitAllowsDecimals && !allowFractions) {
    if (!Number.isInteger(numQty)) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'QUANTITY_MUST_BE_INTEGER',
        message: `El producto "${productName || 'sin nombre'}" se vende por ${normalizedUnit} y la cantidad debe ser un número entero. Se recibió ${quantity}.`,
      });
    }
    return numQty;
  }

  // Unidades fraccionables (o cuenta dividida): redondear a 3 decimales
  const rounded = round3(numQty);
  if (numQty > 0 && rounded < 0.001) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      code: 'QUANTITY_TOO_SMALL',
      message: `La cantidad mínima para "${productName || 'sin nombre'}" (${normalizedUnit}) es 0.001.`,
    });
  }
  return rounded;
}
