import { Prisma } from '@prisma/client';

export type PriceTier = 'RETAIL' | 'WHOLESALE' | 'PROMO';

export interface ResolvedUnitPrice {
  unitPrice: number;
  priceTier: PriceTier;
}

/**
 * 176a / 292a - Función única usada por todos los flujos de venta:
 * Prioridad automática por línea:
 * 1. WHOLESALE: si wholesale_enabled y el producto tiene wholesalePrice y qty >= wholesaleMinQty
 * 2. PROMO: si no aplica precio etiqueta (useListPrice && listPrice > price) y el producto tiene promoDiscountPct (0 < pct < 100)
 * 3. RETAIL: precio normal
 */
export function resolveLineUnitPrice(
  product: {
    price: number;
    wholesalePrice?: Prisma.Decimal | number | null;
    wholesaleMinQty?: Prisma.Decimal | number | null;
    promoDiscountPct?: Prisma.Decimal | number | null;
    listPrice?: Prisma.Decimal | number | null;
  },
  qty: number,
  business?: { wholesaleEnabled?: boolean | null; useListPrice?: boolean | null } | null,
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

  const basePrice = Number(product.price) || 0;
  const rawListPrice = product.listPrice != null ? Number(product.listPrice) : null;
  const hasActiveListDiscount =
    Boolean(business?.useListPrice) &&
    rawListPrice !== null &&
    rawListPrice > basePrice;

  const rawPromoPct =
    product.promoDiscountPct != null ? Number(product.promoDiscountPct) : null;
  if (
    !hasActiveListDiscount &&
    rawPromoPct !== null &&
    Number.isFinite(rawPromoPct) &&
    rawPromoPct > 0 &&
    rawPromoPct < 100
  ) {
    return {
      unitPrice: Math.round(basePrice * (1 - rawPromoPct / 100) * 100) / 100,
      priceTier: 'PROMO',
    };
  }

  return {
    unitPrice: product.price,
    priceTier: 'RETAIL',
  };
}

export interface ChannelPricingContext {
  pedidosYaChannelEnabled?: boolean | null;
  pedidosYaCommissionPct?: number | null;
  pedidosYaTaxPct?: number | null;
  pedidosYaPriceMode?: string | null; // 'RECARGO' | 'MANTENER_GANANCIA' | 'MISMO_PRECIO'
  pedidosYaRounding?: string | null; // 'SIN_REDONDEO' | 'REDONDEO_0_50' | 'REDONDEO_1' | 'REDONDEO_5'
  pedidosYaCapAtListPrice?: boolean | null;
  useListPrice?: boolean | null;
}

export function applyPedidosYaMarkup(
  basePrice: number,
  config?: ChannelPricingContext | null,
): number {
  if (basePrice <= 0) return 0;
  const commPct = config?.pedidosYaCommissionPct ?? 27;
  const taxPct = config?.pedidosYaTaxPct ?? 7;
  const mode = config?.pedidosYaPriceMode || 'MANTENER_GANANCIA';
  const rounding = config?.pedidosYaRounding || 'REDONDEO_1';

  const commRate = commPct / 100;
  const taxRate = taxPct / 100;
  const totalRate = commRate + taxRate;

  let rawPrice = basePrice;
  if (mode === 'RECARGO') {
    rawPrice = basePrice * (1 + totalRate);
  } else if (mode === 'MANTENER_GANANCIA') {
    const divisor = 1 - totalRate;
    rawPrice = divisor > 0.0001 ? basePrice / divisor : basePrice;
  } else if (mode === 'MISMO_PRECIO') {
    rawPrice = basePrice;
  }

  let roundedPrice = rawPrice;
  const eps = 0.00001;
  if (rounding === 'SIN_REDONDEO') {
    roundedPrice = Math.round(rawPrice * 100) / 100;
  } else if (rounding === 'REDONDEO_0_50') {
    roundedPrice = Math.ceil((rawPrice - eps) * 2) / 2;
  } else if (rounding === 'REDONDEO_1') {
    roundedPrice = Math.ceil(rawPrice - eps);
  } else if (rounding === 'REDONDEO_5') {
    roundedPrice = Math.ceil((rawPrice - eps) / 5) * 5;
  } else {
    roundedPrice = Math.ceil(rawPrice - eps);
  }

  return Math.round(roundedPrice * 100) / 100;
}

export function resolveChannelUnitPrice(
  product: {
    price: number;
    wholesalePrice?: Prisma.Decimal | number | null;
    wholesaleMinQty?: Prisma.Decimal | number | null;
    promoDiscountPct?: Prisma.Decimal | number | null;
    listPrice?: Prisma.Decimal | number | null;
  },
  qty: number,
  business?: ({ wholesaleEnabled?: boolean | null } & ChannelPricingContext) | null,
  channel?: string | null,
): {
  unitPrice: number;
  priceTier: PriceTier;
  listPrice?: number | null;
} {
  const ch = (channel || 'MOSTRADOR').toUpperCase();
  const effectiveProduct =
    ch === 'PEDIDOSYA'
      ? { ...product, promoDiscountPct: null }
      : product;
  const resolved = resolveLineUnitPrice(effectiveProduct, qty, business);

  if (ch !== 'PEDIDOSYA') {
    const listPrice = business?.useListPrice && product?.listPrice != null ? Number(product.listPrice) : null;
    return {
      unitPrice: resolved.unitPrice,
      priceTier: resolved.priceTier,
      listPrice,
    };
  }

  let channelUnitPrice = applyPedidosYaMarkup(resolved.unitPrice, business);
  let channelListPrice: number | null = null;

  if (business?.useListPrice && product?.listPrice != null) {
    const baseListPrice = Number(product.listPrice);
    channelListPrice = applyPedidosYaMarkup(baseListPrice, business);
    if (business.pedidosYaCapAtListPrice) {
      channelUnitPrice = Math.min(channelUnitPrice, baseListPrice);
    }
  }

  return {
    unitPrice: channelUnitPrice,
    priceTier: resolved.priceTier,
    listPrice: channelListPrice,
  };
}
