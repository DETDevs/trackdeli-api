export interface SalePaymentBreakdown {
  cash: number;
  card: number;
  transfer: number;
}

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

    const cashMatch = notes.match(/Efectivo\s*[:$]?\s*([0-9]+(?:\.[0-9]+)?)/i);
    const cardMatch = notes.match(/Tarjeta\s*[:$]?\s*([0-9]+(?:\.[0-9]+)?)/i);

    if (cashMatch) {
      const cash = parseFloat(cashMatch[1]) || 0;
      const card = cardMatch ? parseFloat(cardMatch[1]) || Math.max(0, total - cash) : Math.max(0, total - cash);
      return { cash, card, transfer: 0 };
    }

    const half = Math.round((total / 2) * 100) / 100;
    return { cash: half, card: Math.max(0, total - half), transfer: 0 };
  }

  return { cash: 0, card: 0, transfer: 0 };
}

