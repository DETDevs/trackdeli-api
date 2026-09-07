export interface SalePaymentBreakdown {
  cash: number;
  card: number;
  transfer: number;
}

/**
 * Desglosa los importes de una venta completada según su método de pago.
 * Soporta ventas en EFECTIVO, TARJETA, TRANSFERENCIA y ventas con pago MIXTO
 * parseando las notas estructuradas generadas por el POS (e.g. "[MIXTO: Efectivo $X + Tarjeta $Y]").
 */
export function getSalePaymentBreakdown(sale: {
  paymentMethod: string;
  total: number;
  notes?: string | null;
}): SalePaymentBreakdown {
  const total = Number(sale.total || 0);

  if (sale.paymentMethod === 'EFECTIVO') {
    return { cash: total, card: 0, transfer: 0 };
  }

  if (sale.paymentMethod === 'TARJETA') {
    return { cash: 0, card: total, transfer: 0 };
  }

  if (sale.paymentMethod === 'TRANSFERENCIA') {
    return { cash: 0, card: 0, transfer: total };
  }

  if (sale.paymentMethod === 'MIXTO') {
    const notes = sale.notes || '';
    // Buscar monto en efectivo: e.g. "Efectivo $1190.25", "Efectivo: 1190.25", "Efectivo 1190.25"
    const cashMatch = notes.match(/Efectivo\s*[:$]?\s*([0-9]+(?:\.[0-9]+)?)/i);
    const cardMatch = notes.match(/Tarjeta\s*[:$]?\s*([0-9]+(?:\.[0-9]+)?)/i);

    if (cashMatch) {
      const cash = parseFloat(cashMatch[1]) || 0;
      const card = cardMatch ? parseFloat(cardMatch[1]) || Math.max(0, total - cash) : Math.max(0, total - cash);
      return { cash, card, transfer: 0 };
    }

    // Fallback en caso de venta mixta sin notas formateadas
    const half = Math.round((total / 2) * 100) / 100;
    return { cash: half, card: Math.max(0, total - half), transfer: 0 };
  }

  return { cash: 0, card: 0, transfer: 0 };
}
