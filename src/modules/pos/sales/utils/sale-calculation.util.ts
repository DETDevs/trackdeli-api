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
  subtotal?: number;
  priceTier?: string;
  listPrice?: number | null;
  taxable?: boolean | null;
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
  discountAmount: number; // descuento manual del cajero
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
    const lines: CalculatedSaleLine[] = [];

    for (const item of rawItems) {
      const itemDiscount = item.discount || 0;
      const itemSubtotal = isSplitSale && item.subtotal !== undefined
        ? item.subtotal
        : (item.unitPrice * item.quantity - itemDiscount);

      const netCents = Math.round(itemSubtotal * 100);
      subtotalCents += netCents;

      lines.push({
        productId: item.productId || null,
        productName: item.productName,
        barcode: item.barcode || null,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        discount: itemDiscount,
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
  // MODO PER_LINE (Ticket 206a - Estándar nuevo en centavos exactos)
  // ══════════════════════════════════════════════════════════════════════
  const useListPrice = Boolean(business.useListPrice);
  const n = rawItems.length;

  interface TempLine {
    raw: RawSaleItemCalculationInput;
    netCents: number;
    unitPriceCents: number;
    listPriceNum: number | null;
    listPriceDiscountCents: number;
    lineListPriceTotalCents: number;
    manualDiscountShareCents: number;
    taxable: boolean;
    lineTaxCents: number;
  }

  let subtotalNetCents = 0;
  let totalListPriceCents = 0;
  let totalListDiscountCents = 0;

  const tempLines: TempLine[] = [];

  for (const item of rawItems) {
    const itemDiscountCents = Math.round((item.discount || 0) * 100);
    const unitPriceCents = Math.round(item.unitPrice * 100);
    const qty = item.quantity;

    const netCents = isSplitSale && item.subtotal !== undefined
      ? Math.round(item.subtotal * 100)
      : Math.round(item.unitPrice * qty * 100) - itemDiscountCents;

    subtotalNetCents += netCents;

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
      netCents,
      unitPriceCents,
      listPriceNum,
      listPriceDiscountCents,
      lineListPriceTotalCents,
      manualDiscountShareCents: 0,
      taxable: Boolean(item.taxable),
      lineTaxCents: 0,
    });
  }

  // 2. Reparto proporcional del descuento manual del cajero
  const rawDiscountAmountCents = Math.max(0, Math.round((discountAmountInput || 0) * 100));
  const totalManualDiscountCents = Math.min(rawDiscountAmountCents, subtotalNetCents);

  if (totalManualDiscountCents > 0 && subtotalNetCents > 0) {
    let accumulatedShareCents = 0;
    for (let i = 0; i < n; i++) {
      if (i === n - 1) {
        // La última línea absorbe la diferencia de centavos
        tempLines[i].manualDiscountShareCents = totalManualDiscountCents - accumulatedShareCents;
      } else {
        const share = Math.round(totalManualDiscountCents * (tempLines[i].netCents / subtotalNetCents));
        tempLines[i].manualDiscountShareCents = share;
        accumulatedShareCents += share;
      }
    }
  }

  // 3. Cálculo de IVA por línea (15% sobre la base gravable neta)
  let totalTaxCents = 0;

  for (const line of tempLines) {
    const taxableBaseCents = Math.max(0, line.netCents - line.manualDiscountShareCents);
    if (line.taxable) {
      line.lineTaxCents = Math.round(taxableBaseCents * 0.15);
      totalTaxCents += line.lineTaxCents;
    } else {
      line.lineTaxCents = 0;
    }
  }

  // 4. Totales generales
  const subtotalBeforeTaxCents = subtotalNetCents - totalManualDiscountCents;
  const totalCents = subtotalBeforeTaxCents + totalTaxCents;

  const lines: CalculatedSaleLine[] = tempLines.map((tl) => ({
    productId: tl.raw.productId || null,
    productName: tl.raw.productName,
    barcode: tl.raw.barcode || null,
    unitPrice: tl.raw.unitPrice,
    quantity: tl.raw.quantity,
    discount: tl.raw.discount || 0,
    subtotal: tl.netCents / 100,
    priceTier: tl.raw.priceTier || 'RETAIL',
    listPrice: tl.listPriceNum,
    listPriceDiscount: tl.listPriceDiscountCents / 100,
    manualDiscountShare: tl.manualDiscountShareCents / 100,
    taxable: tl.taxable,
    taxRate: tl.taxable ? 15 : 0,
    taxAmount: tl.lineTaxCents / 100,
  }));

  return {
    taxModel: 'PER_LINE',
    subtotal: subtotalNetCents / 100,
    discountAmount: totalManualDiscountCents / 100,
    subtotalBeforeTax: subtotalBeforeTaxCents / 100,
    listPriceTotal: totalListPriceCents / 100,
    listDiscountTotal: totalListDiscountCents / 100,
    taxEnabled: totalTaxCents > 0,
    taxIncluded: false, // En PER_LINE siempre suma sobre el subtotal antes de IVA
    taxRate: 15,
    taxAmount: totalTaxCents / 100,
    total: totalCents / 100,
    lines,
  };
}
