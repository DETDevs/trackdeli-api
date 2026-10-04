export interface SalePaymentBreakdown {
  cash: number;
  card: number;
  transfer: number;
  other: number;
  credit: number;
}

export function getSalePaymentBreakdown(sale: any): SalePaymentBreakdown {
  const result: SalePaymentBreakdown = { cash: 0, card: 0, transfer: 0, other: 0, credit: 0 };

  if (sale.payments && Array.isArray(sale.payments) && sale.payments.length > 0) {
    for (const p of sale.payments) {
      if (p.method === 'EFECTIVO') result.cash += p.amount;
      else if (p.method === 'TARJETA') result.card += p.amount;
      else if (p.method === 'TRANSFERENCIA') result.transfer += p.amount;
      else if (p.method === 'CREDITO') result.credit += p.amount;
      else result.other += p.amount;
    }
    return result;
  }

  // Fallback para datos muy viejos que no hayan pasado por la migración por algún motivo.
  const total = Number(sale.total || 0);

  if (sale.paymentMethod === 'EFECTIVO') {
    result.cash = total;
  } else if (sale.paymentMethod === 'TARJETA') {
    result.card = total;
  } else if (sale.paymentMethod === 'TRANSFERENCIA') {
    result.transfer = total;
  } else if (sale.paymentMethod === 'CREDITO') {
    result.credit = total;
  } else if (sale.paymentMethod === 'MIXTO') {
    const notes = sale.notes || '';
    const cashMatch = notes.match(/Efectivo\s*[:$]?\s*([0-9]+(?:\.[0-9]+)?)/i);
    const cardMatch = notes.match(/Tarjeta\s*[:$]?\s*([0-9]+(?:\.[0-9]+)?)/i);

    if (cashMatch) {
      const cash = parseFloat(cashMatch[1]) || 0;
      const card = cardMatch ? parseFloat(cardMatch[1]) || Math.max(0, total - cash) : Math.max(0, total - cash);
      result.cash = cash;
      result.card = card;
    } else {
      const half = Math.round((total / 2) * 100) / 100;
      result.cash = half;
      result.card = Math.max(0, total - half);
    }
  }

  return result;
}

