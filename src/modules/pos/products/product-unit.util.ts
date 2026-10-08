import { BadRequestException } from '@nestjs/common';

export const ALLOWED_PRODUCT_UNITS = ['UND', 'LT', 'GAL', 'KG', 'LB'] as const;
export type ProductUnit = (typeof ALLOWED_PRODUCT_UNITS)[number];

export function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

export function validateProductQuantity(
  unit: string | undefined | null,
  quantity: number,
  productName?: string,
): number {
  if (typeof quantity !== 'number' || isNaN(quantity)) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      code: 'INVALID_QUANTITY',
      message: `La cantidad ingresada no es válida.`,
    });
  }

  const rounded = round3(quantity);
  const normalizedUnit = (unit || 'UND').trim().toUpperCase();

  if (normalizedUnit === 'UND') {
    // La cantidad debe ser un número entero estricto
    if (!Number.isInteger(rounded) || Math.abs(rounded - Math.round(rounded)) > 1e-6) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'QUANTITY_MUST_BE_INTEGER',
        message: `El producto "${productName || 'sin nombre'}" se vende por unidad (UND) y la cantidad debe ser un número entero. Se recibió ${quantity}.`,
      });
    }
  } else {
    // Para LT, GAL, KG, LB se aceptan hasta 3 decimales y mínimo 0.001
    if (rounded < 0.001) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'INVALID_QUANTITY',
        message: `La cantidad mínima para el producto "${productName || 'sin nombre'}" (${normalizedUnit}) es 0.001.`,
      });
    }
  }

  return rounded;
}
