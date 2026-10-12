import { Prisma } from '@prisma/client';

export type PriceTier = 'RETAIL' | 'WHOLESALE';

export interface ResolvedUnitPrice {
  unitPrice: number;
  priceTier: PriceTier;
}

/**
 * 176a - Función única usada por todos los flujos de venta:
 * Si wholesale_enabled en el negocio y el producto tiene precio por mayor y qty >= wholesale_min_qty -> precio por mayor;
 * si no -> precio normal.
 */
export function resolveLineUnitPrice(
  product: {
    price: number;
    wholesalePrice?: Prisma.Decimal | number | null;
    wholesaleMinQty?: Prisma.Decimal | number | null;
  },
  qty: number,
  business?: { wholesaleEnabled?: boolean | null } | null,
): ResolvedUnitPrice {
  const isWholesaleActive = Boolean(business?.wholesaleEnabled);
  const wholesalePrice =
    product.wholesalePrice != null ? Number(product.wholesalePrice) : null;
  const wholesaleMinQty =
    product.wholesaleMinQty != null ? Number(product.wholesaleMinQty) : null;

  if (
    isWholesaleActive &&
    wholesalePrice !== null &&
    wholesalePrice > 0 &&
    wholesaleMinQty !== null &&
    wholesaleMinQty > 0 &&
    qty >= wholesaleMinQty
  ) {
    return {
      unitPrice: wholesalePrice,
      priceTier: 'WHOLESALE',
    };
  }

  return {
    unitPrice: product.price,
    priceTier: 'RETAIL',
  };
}
