/**
 * 206a - Utilidad compartida de cálculo de venta (online y sync offline)
 * 
 * Reglas de Alex:
 * 1. Margen sobre costo: venta = costo * (1 + margen/100).
 * 2. IVA 15% fijo, se calcula sobre el precio de venta (neto) y se suma.
 * 3. En centavos enteros para que el backend y desktop coincidan al centavo.
 * 4. Descuento manual del cajero se reparte proporcionalmente entre líneas; la última absorbe diferencias.
 * 5. Descuento de etiqueta de línea = max(0, listPrice - unitPrice) * cantidad. NO suma a discountAmount.
 * 6. taxModel: 'PER_LINE' para ventas nuevas con taxable; 'LEGACY' para ventas viejas o clientes no actualizados.
 */

export interface RawSaleItemCalculationInput {
  productId?: string | null;
  productName: string;
  barcode?: string | null;
  unitPrice: number;
  quantity: number;
  discount?: number;
  promoDiscount?: number;
  promotionId?: string | null;
  promotionName?: string | null;
  subtotal?: number;
  priceTier?: string;
  listPrice?: number | null;
  taxable?: boolean | null;
  allowDiscount?: boolean;
}

export interface BusinessCalculationContext {
  useListPrice?: boolean;
  taxEnabled?: boolean;
  taxIncluded?: boolean;
  taxRate?: number;
}

export interface CalculatedSaleLine {
  productId?: string | null;
  productName: string;
  barcode?: string | null;
  unitPrice: number;
  quantity: number;
  discount: number;
  promoDiscount: number;
  promotionId: string | null;
  promotionName: string | null;
  subtotal: number; // neto cobrado de la línea
  priceTier: string;
  listPrice: number | null;
  listPriceDiscount: number;
  manualDiscountShare: number;
  taxable: boolean;
  taxRate: number;
  taxAmount: number;
}

export interface CalculatedSaleSummary {
  taxModel: 'PER_LINE' | 'LEGACY';
  subtotal: number; // suma de netos de las líneas
  discountAmount: number; // descuento manual general del cajero
  lineDiscountTotal: number; // suma de descuentos manuales por línea
  promoDiscountTotal: number; // suma de descuentos por promociones dinámicas
  eligibleForGlobalDiscountSubtotal: number; // subtotal elegible para descuento general
  subtotalBeforeTax: number; // subtotal - discountAmount
  listPriceTotal: number; // suma de precios de etiqueta
  listDiscountTotal: number; // suma de descuentos de etiqueta
  taxEnabled: boolean;
  taxIncluded: boolean;
  taxRate: number;
  taxAmount: number;
  total: number;
  lines: CalculatedSaleLine[];
}

export function isLineBlockedFromManualDiscount(
  item: {
    allowDiscount?: boolean;
    priceTier?: string | null;
    listPrice?: number | null;
    unitPrice: number;
    promotionId?: string | null;
    promoDiscount?: number | null;
  },
  useListPrice: boolean = false,
): boolean {
  if (item.allowDiscount === false) return true;
  if (item.promotionId || Number(item.promoDiscount || 0) > 0) return true;
  const tier = (item.priceTier || 'RETAIL').toUpperCase();
  if (tier === 'WHOLESALE' || tier === 'PROMO') return true;
  if (
    useListPrice &&
    item.listPrice !== undefined &&
    item.listPrice !== null &&
    Number(item.listPrice) > Number(item.unitPrice)
  ) {
    return true;
  }
  return false;
}

export function calculateSaleTotals(
  rawItems: RawSaleItemCalculationInput[],
  discountAmountInput: number = 0,
  business: BusinessCalculationContext = {},
  isSplitSale: boolean = false,
): CalculatedSaleSummary {
  // 1. Detectar si el cliente envía el nuevo modelo por línea o el legacy
  const isPerLine = rawItems.some((i) => i.taxable !== undefined && i.taxable !== null);

  if (!isPerLine) {
    // ══════════════════════════════════════════════════════════════════════
    // MODO LEGACY (Compatibilidad con desktops no actualizados)
    // ══════════════════════════════════════════════════════════════════════
    let subtotalCents = 0;
    let lineDiscountTotalCents = 0;
    let promoDiscountTotalCents = 0;
    let eligibleForGlobalCents = 0;
    const lines: CalculatedSaleLine[] = [];

    for (const item of rawItems) {
      const isBlocked = isLineBlockedFromManualDiscount(item, Boolean(business.useListPrice));
      const grossLineCents = Math.max(0, Math.round(item.unitPrice * item.quantity * 100));
      const promoDiscountCents = Math.min(
        grossLineCents,
        Math.max(0, Math.round((item.promoDiscount || 0) * 100)),
      );
      const rawItemDiscCents = Math.max(0, Math.round((item.discount || 0) * 100));
      const itemDiscCents = isBlocked
        ? 0
        : Math.min(rawItemDiscCents, Math.max(0, grossLineCents - promoDiscountCents));
      const itemDiscount = itemDiscCents / 100;

      const netCents = isSplitSale && item.subtotal !== undefined
        ? Math.round(item.subtotal * 100)
        : Math.max(0, grossLineCents - promoDiscountCents - itemDiscCents);

      subtotalCents += netCents;
      lineDiscountTotalCents += itemDiscCents;
      promoDiscountTotalCents += promoDiscountCents;
      if (
        !isBlocked &&
        itemDiscCents === 0 &&
        promoDiscountCents === 0 &&
        netCents > 0
      ) {
        eligibleForGlobalCents += netCents;
      }

      lines.push({
        productId: item.productId || null,
        productName: item.productName,
        barcode: item.barcode || null,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        discount: itemDiscount,
        promoDiscount: promoDiscountCents / 100,
        promotionId: item.promotionId || null,
        promotionName: item.promotionName || null,
        subtotal: netCents / 100,
        priceTier: item.priceTier || 'RETAIL',
        listPrice: null,
        listPriceDiscount: 0,
        manualDiscountShare: 0,
        taxable: false,
        taxRate: 0,
        taxAmount: 0,
      });
    }

    const discountAmountCents = Math.max(0, Math.round((discountAmountInput || 0) * 100));
    const finalSubtotalCents = Math.max(0, subtotalCents - discountAmountCents);

    let taxAmountCents = 0;
    let totalCents = finalSubtotalCents;

    const taxEnabled = Boolean(business.taxEnabled);
    const taxIncluded = Boolean(business.taxIncluded);
    const taxRate = business.taxRate || 0;

    if (taxEnabled && taxRate > 0) {
      const rateDecimal = taxRate / 100;
      if (taxIncluded) {
        // En impuesto incluido, finalSubtotal ya trae el impuesto
        const baseCents = Math.round(finalSubtotalCents / (1 + rateDecimal));
        taxAmountCents = finalSubtotalCents - baseCents;
        totalCents = finalSubtotalCents;
      } else {
        // En impuesto no incluido, el impuesto se suma encima
        taxAmountCents = Math.round(finalSubtotalCents * rateDecimal);
        totalCents = finalSubtotalCents + taxAmountCents;
      }
    }

    return {
      taxModel: 'LEGACY',
      subtotal: subtotalCents / 100,
      discountAmount: discountAmountCents / 100,
      lineDiscountTotal: lineDiscountTotalCents / 100,
      promoDiscountTotal: promoDiscountTotalCents / 100,
      eligibleForGlobalDiscountSubtotal: eligibleForGlobalCents / 100,
      subtotalBeforeTax: finalSubtotalCents / 100,
      listPriceTotal: 0,
      listDiscountTotal: 0,
      taxEnabled,
      taxIncluded,
      taxRate,
      taxAmount: taxAmountCents / 100,
      total: totalCents / 100,
      lines,
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // MODO PER_LINE (Ticket 206a + 292a + 294d - Estándar nuevo en centavos exactos)
  // ══════════════════════════════════════════════════════════════════════
  const useListPrice = Boolean(business.useListPrice);

  interface TempLine {
    raw: RawSaleItemCalculationInput;
    effectiveDiscountCents: number;
    promoDiscountCents: number;
    netCents: number;
    unitPriceCents: number;
    listPriceNum: number | null;
    listPriceDiscountCents: number;
    lineListPriceTotalCents: number;
    manualDiscountShareCents: number;
    isEligibleForGlobal: boolean;
    taxable: boolean;
    lineTaxCents: number;
  }

  let subtotalNetCents = 0;
  let totalListPriceCents = 0;
  let totalListDiscountCents = 0;
  let totalLineDiscountCents = 0;
  let totalPromoDiscountCents = 0;
  let eligibleForGlobalCents = 0;

  const tempLines: TempLine[] = [];

  for (const item of rawItems) {
    const unitPriceCents = Math.round(item.unitPrice * 100);
    const qty = item.quantity;
    const grossLineCents = Math.max(0, Math.round(item.unitPrice * qty * 100));
    const isBlocked = isLineBlockedFromManualDiscount(item, useListPrice);
    const promoDiscountCents = Math.min(
      grossLineCents,
      Math.max(0, Math.round((item.promoDiscount || 0) * 100)),
    );
    const rawItemDiscountCents = Math.max(0, Math.round((item.discount || 0) * 100));
    const itemDiscountCents = isBlocked
      ? 0
      : Math.min(rawItemDiscountCents, Math.max(0, grossLineCents - promoDiscountCents));

    const netCents = isSplitSale && item.subtotal !== undefined
      ? Math.round(item.subtotal * 100)
      : Math.max(0, grossLineCents - promoDiscountCents - itemDiscountCents);

    subtotalNetCents += netCents;
    totalLineDiscountCents += itemDiscountCents;
    totalPromoDiscountCents += promoDiscountCents;

    const isEligibleForGlobal =
      !isBlocked && itemDiscountCents === 0 && promoDiscountCents === 0 && netCents > 0;
    if (isEligibleForGlobal) {
      eligibleForGlobalCents += netCents;
    }

    let listPriceNum: number | null = null;
    let listPriceDiscountCents = 0;
    let lineListPriceTotalCents = 0;

    if (useListPrice && item.listPrice !== undefined && item.listPrice !== null) {
      listPriceNum = Number(item.listPrice);
      const listPriceCents = Math.round(listPriceNum * 100);
      lineListPriceTotalCents = Math.round(listPriceCents * qty);
      const unitDiffCents = Math.max(0, listPriceCents - unitPriceCents);
      listPriceDiscountCents = Math.round(unitDiffCents * qty);
    } else {
      lineListPriceTotalCents = Math.max(0, netCents);
    }

    totalListPriceCents += lineListPriceTotalCents;
    totalListDiscountCents += listPriceDiscountCents;

    tempLines.push({
      raw: item,
      effectiveDiscountCents: itemDiscountCents,
      promoDiscountCents,
      netCents,
      unitPriceCents,
      listPriceNum,
      listPriceDiscountCents,
      lineListPriceTotalCents,
      manualDiscountShareCents: 0,
      isEligibleForGlobal,
      taxable: Boolean(item.taxable),
      lineTaxCents: 0,
    });
  }

  // 2. Reparto proporcional del descuento manual general SOLO sobre líneas elegibles (Opción A)
  const rawDiscountAmountCents = Math.max(0, Math.round((discountAmountInput || 0) * 100));
  const totalManualDiscountCents = Math.min(rawDiscountAmountCents, eligibleForGlobalCents);

  if (totalManualDiscountCents > 0 && eligibleForGlobalCents > 0) {
    const eligibleLines = tempLines.filter((tl) => tl.isEligibleForGlobal);
    let accumulatedShareCents = 0;
    for (let i = 0; i < eligibleLines.length; i++) {
      if (i === eligibleLines.length - 1) {
        // La última línea elegible absorbe la diferencia de centavos
        eligibleLines[i].manualDiscountShareCents = totalManualDiscountCents - accumulatedShareCents;
      } else {
        const share = Math.round(
          totalManualDiscountCents * (eligibleLines[i].netCents / eligibleForGlobalCents),
        );
        eligibleLines[i].manualDiscountShareCents = share;
        accumulatedShareCents += share;
      }
    }
  }

  // 3. Cálculo de IVA por línea (respetando taxEnabled, taxIncluded y taxRate del negocio)
  const isTaxEnabled =
    business.taxEnabled !== undefined && business.taxEnabled !== null
      ? Boolean(business.taxEnabled)
      : true;
  const isTaxIncluded = Boolean(business.taxIncluded);
  const rawTaxRate =
    business.taxRate !== undefined && business.taxRate !== null && Number(business.taxRate) > 0
      ? Number(business.taxRate)
      : 15;
  const effectiveTaxRate = isTaxEnabled ? rawTaxRate : 0;
  const rateDecimal = effectiveTaxRate / 100;

  let totalTaxCents = 0;

  for (const line of tempLines) {
    const taxableBaseCents = Math.max(0, line.netCents - line.manualDiscountShareCents);
    if (line.taxable && effectiveTaxRate > 0) {
      if (isTaxIncluded) {
        const baseCents = Math.round(taxableBaseCents / (1 + rateDecimal));
        line.lineTaxCents = taxableBaseCents - baseCents;
      } else {
        line.lineTaxCents = Math.round(taxableBaseCents * rateDecimal);
      }
      totalTaxCents += line.lineTaxCents;
    } else {
      line.lineTaxCents = 0;
    }
  }

  // 4. Totales generales
  const subtotalBeforeTaxCents = subtotalNetCents - totalManualDiscountCents;
  const totalCents = isTaxIncluded
    ? subtotalBeforeTaxCents
    : subtotalBeforeTaxCents + totalTaxCents;

  const lines: CalculatedSaleLine[] = tempLines.map((tl) => ({
    productId: tl.raw.productId || null,
    productName: tl.raw.productName,
    barcode: tl.raw.barcode || null,
    unitPrice: tl.raw.unitPrice,
    quantity: tl.raw.quantity,
    discount: tl.effectiveDiscountCents / 100,
    promoDiscount: tl.promoDiscountCents / 100,
    promotionId: tl.raw.promotionId || null,
    promotionName: tl.raw.promotionName || null,
    subtotal: tl.netCents / 100,
    priceTier: tl.raw.priceTier || 'RETAIL',
    listPrice: tl.listPriceNum,
    listPriceDiscount: tl.listPriceDiscountCents / 100,
    manualDiscountShare: tl.manualDiscountShareCents / 100,
    taxable: tl.taxable,
    taxRate: tl.taxable && effectiveTaxRate > 0 ? effectiveTaxRate : 0,
    taxAmount: tl.lineTaxCents / 100,
  }));

  return {
    taxModel: 'PER_LINE',
    subtotal: subtotalNetCents / 100,
    discountAmount: totalManualDiscountCents / 100,
    lineDiscountTotal: totalLineDiscountCents / 100,
    promoDiscountTotal: totalPromoDiscountCents / 100,
    eligibleForGlobalDiscountSubtotal: eligibleForGlobalCents / 100,
    subtotalBeforeTax: subtotalBeforeTaxCents / 100,
    listPriceTotal: totalListPriceCents / 100,
    listDiscountTotal: totalListDiscountCents / 100,
    taxEnabled: isTaxEnabled && totalTaxCents > 0,
    taxIncluded: isTaxIncluded,
    taxRate: effectiveTaxRate,
    taxAmount: totalTaxCents / 100,
    total: totalCents / 100,
    lines,
  };
}

/**
 * Calcula el monto de propina porcentual en centavos a partir del total de la venta.
 */
export function calculateTipFromTotal(total: number, percent: number): number {
  const totalCents = Math.round(Number(total || 0) * 100);
  const percentBps = Math.round(Number(percent || 0) * 100);
  if (totalCents <= 0 || percentBps <= 0) return 0;
  return Math.round((totalCents * percentBps) / 10000) / 100;
}
