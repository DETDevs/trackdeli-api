import { BadRequestException } from '@nestjs/common';
import { round3 } from '../products/product-unit.util';

export interface ProratedSplitItem {
  productId?: string;
  productName: string;
  unitPrice: number;
  quantity: number;
  discount: number;
  subtotal: number;
}

export interface EqualSplitCalculationResult {
  subAccountIdx: number;
  isLastSubAccount: boolean;
  fixedAmount: number;
  saDiscount: number;
  targetSubtotal: number;
  items: ProratedSplitItem[];
}

/**
 * Corrige el formato del nombre de la mesa evitando prefijos duplicados como "Mesa Mesa 1".
 */
export function formatTableDisplayName(tableLabel?: string | null, tableNumber?: string | null): string {
  if (!tableNumber) return tableLabel || 'Mesa';
  const numStr = String(tableNumber).trim();
  const labelStr = (tableLabel || 'Mesa').trim();
  if (numStr.toLowerCase().startsWith(labelStr.toLowerCase())) {
    return numStr;
  }
  return `${labelStr} ${numStr}`;
}

/**
 * Ordena las subcuentas de manera 100% determinística sin importar el orden de cobro.
 * Prioridad: createdAt ASC -> label ASC (numérico) -> id ASC.
 */
export function sortSubAccountsDeterministically<
  T extends { id: string; label: string; createdAt: Date | string }
>(subAccounts: T[]): T[] {
  return [...subAccounts].sort((a, b) => {
    const timeA = new Date(a.createdAt).getTime();
    const timeB = new Date(b.createdAt).getTime();
    if (timeA !== timeB) return timeA - timeB;
    const labelComp = a.label.localeCompare(b.label, undefined, { numeric: true });
    if (labelComp !== 0) return labelComp;
    return a.id.localeCompare(b.id);
  });
}

/**
 * 171e - Calcula los renglones prorrateados de productos reales para una subcuenta en modo EQUAL.
 * - Cantidad prorrateada: round3(origQty * (monto_parte / total_orden)) para las primeras N-1 partes.
 * - La última parte toma el residuo exacto: origQty - suma_anteriores.
 * - Ajuste de centavos en subtotales de línea para que sum(subtotales) cuadre exactamente con targetSubtotal.
 */
export function calculateEqualSplitItems(
  order: {
    items: Array<{
      id?: string;
      productId?: string | null;
      productName: string;
      unitPrice: number;
      quantity: any;
    }>;
    discountPercent?: any;
    discountAmount?: any;
  },
  subAccounts: Array<{
    id: string;
    label: string;
    fixedAmount?: any;
    createdAt: Date | string;
  }>,
  targetSubAccountId: string,
  business?: {
    taxRate?: number | null;
    taxEnabled?: boolean | null;
    taxIncluded?: boolean | null;
  } | null,
): EqualSplitCalculationResult {
  const activeItems = (order.items || []).filter((i) => Number(i.quantity) > 0);
  if (activeItems.length === 0) {
    throw new BadRequestException('El pedido de la mesa no contiene productos para facturar');
  }

  const sortedSubAccounts = sortSubAccountsDeterministically(subAccounts);
  const subAccountIdx = sortedSubAccounts.findIndex((sa) => sa.id === targetSubAccountId);
  if (subAccountIdx === -1) {
    throw new BadRequestException('Subcuenta no encontrada en la orden');
  }

  const partsCount = sortedSubAccounts.length;
  const isLastSubAccount = subAccountIdx === partsCount - 1;
  const targetSubAccount = sortedSubAccounts[subAccountIdx];
  const fixedAmount = Number(targetSubAccount.fixedAmount || 0);

  // Total orden a partir de las subcuentas
  const orderTotal = Math.round(
    sortedSubAccounts.reduce((sum, sa) => sum + Number(sa.fixedAmount || 0), 0) * 100,
  ) / 100;

  // Cálculo de descuento total de la orden
  let totalOrderSubtotal = 0;
  for (const it of activeItems) {
    totalOrderSubtotal += Number(it.quantity) * Number(it.unitPrice);
  }
  totalOrderSubtotal = Math.round(totalOrderSubtotal * 100) / 100;

  const discountPercent = Number(order.discountPercent || 0);
  const discountAmountTotal = Number(order.discountAmount || 0);
  let totalOrderDiscount = 0;
  if (discountPercent > 0) {
    totalOrderDiscount = Math.round(totalOrderSubtotal * (discountPercent / 100) * 100) / 100;
  } else if (discountAmountTotal > 0) {
    totalOrderDiscount = Math.min(totalOrderSubtotal, Math.round(discountAmountTotal * 100) / 100);
  }

  // Prorrateo de descuento para esta subcuenta
  let saDiscount = 0;
  if (totalOrderDiscount > 0 && orderTotal > 0) {
    let accDisc = 0;
    for (let k = 0; k < partsCount - 1; k++) {
      const discK = Math.round(
        totalOrderDiscount * (Number(sortedSubAccounts[k].fixedAmount || 0) / orderTotal) * 100,
      ) / 100;
      if (k === subAccountIdx) saDiscount = discK;
      accDisc += discK;
    }
    if (isLastSubAccount) {
      saDiscount = Math.round((totalOrderDiscount - accDisc) * 100) / 100;
    }
  }

  // Prorrateo de cantidades de ítems
  const proratedQtys: number[] = [];
  for (const item of activeItems) {
    const origQty = round3(Number(item.quantity));
    let accQty = 0;
    let myQty = 0;

    for (let k = 0; k < partsCount - 1; k++) {
      const qK = round3(origQty * (Number(sortedSubAccounts[k].fixedAmount || 0) / orderTotal));
      if (k === subAccountIdx) {
        myQty = qK;
      }
      accQty = round3(accQty + qK);
    }
    if (isLastSubAccount) {
      myQty = round3(origQty - accQty);
    }
    proratedQtys.push(myQty);
  }

  // Subtotal objetivo antes de impuestos para que el total coincida exactamente con fixedAmount
  const taxRate = business?.taxRate || 0;
  let targetTaxable = fixedAmount;
  if (business?.taxEnabled && !business.taxIncluded && taxRate > 0) {
    let unit = Math.round((fixedAmount / (1 + (taxRate / 100))) * 100) / 100;
    const calcTax = Math.round(unit * (taxRate / 100) * 100) / 100;
    const calcTot = Math.round((unit + calcTax) * 100) / 100;
    const diff = Math.round((fixedAmount - calcTot) * 100) / 100;
    if (diff !== 0) {
      unit = Math.round((unit + diff) * 100) / 100;
    }
    targetTaxable = unit;
  }
  const targetSubtotal = Math.round((targetTaxable + saDiscount) * 100) / 100;

  // Construcción de renglones con subtotales
  const items: ProratedSplitItem[] = activeItems.map((item, idx) => {
    const qty = proratedQtys[idx];
    return {
      productId: item.productId || undefined,
      productName: item.productName,
      unitPrice: Number(item.unitPrice),
      quantity: qty,
      discount: 0,
      subtotal: Math.round(qty * Number(item.unitPrice) * 100) / 100,
    };
  });

  // Ajuste de centavos residuales en subtotales de línea para que sum(subtotal) == targetSubtotal
  if (items.length > 0) {
    const sumOthers = items.slice(0, -1).reduce((sum, it) => sum + it.subtotal, 0);
    const adjustedLast = Math.round((targetSubtotal - sumOthers) * 100) / 100;
    if (adjustedLast >= 0) {
      items[items.length - 1].subtotal = adjustedLast;
    } else {
      let maxIdx = 0;
      for (let i = 1; i < items.length; i++) {
        if (items[i].subtotal > items[maxIdx].subtotal) maxIdx = i;
      }
      const sumWithoutMax = items.reduce(
        (sum, it, idx) => (idx === maxIdx ? sum : sum + it.subtotal),
        0,
      );
      items[maxIdx].subtotal = Math.round((targetSubtotal - sumWithoutMax) * 100) / 100;
    }
  }

  return {
    subAccountIdx,
    isLastSubAccount,
    fixedAmount,
    saDiscount,
    targetSubtotal,
    items,
  };
}
