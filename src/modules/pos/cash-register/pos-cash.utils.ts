import { Prisma } from '@prisma/client';

export interface SalePaymentBreakdown {
  cash: number;
  card: number;
  transfer: number;
  other: number;
  credit: number;
}

export function getSalePaymentBreakdown(sale: any): SalePaymentBreakdown {
  let cash = new Prisma.Decimal(0);
  let card = new Prisma.Decimal(0);
  let transfer = new Prisma.Decimal(0);
  let other = new Prisma.Decimal(0);
  let credit = new Prisma.Decimal(0);

  if (sale.payments && Array.isArray(sale.payments) && sale.payments.length > 0) {
    for (const p of sale.payments) {
      const amt = new Prisma.Decimal(p.amount != null ? p.amount.toString() : 0);
      if (p.method === 'EFECTIVO') cash = cash.plus(amt);
      else if (p.method === 'TARJETA') card = card.plus(amt);
      else if (p.method === 'TRANSFERENCIA') transfer = transfer.plus(amt);
      else if (p.method === 'CREDITO') credit = credit.plus(amt);
      else other = other.plus(amt);
    }
    return {
      cash: Number(cash.toDecimalPlaces(2)),
      card: Number(card.toDecimalPlaces(2)),
      transfer: Number(transfer.toDecimalPlaces(2)),
      other: Number(other.toDecimalPlaces(2)),
      credit: Number(credit.toDecimalPlaces(2)),
    };
  }

  // Fallback para datos muy viejos que no hayan pasado por la migración por algún motivo.
  const total = new Prisma.Decimal(sale.total != null ? sale.total.toString() : 0);

  if (sale.paymentMethod === 'EFECTIVO') {
    cash = total;
  } else if (sale.paymentMethod === 'TARJETA') {
    card = total;
  } else if (sale.paymentMethod === 'TRANSFERENCIA') {
    transfer = total;
  } else if (sale.paymentMethod === 'CREDITO') {
    credit = total;
  } else if (sale.paymentMethod === 'MIXTO') {
    const notes = sale.notes || '';
    const cashMatch = notes.match(/Efectivo\s*[:$]?\s*([0-9]+(?:\.[0-9]+)?)/i);
    const cardMatch = notes.match(/Tarjeta\s*[:$]?\s*([0-9]+(?:\.[0-9]+)?)/i);

    if (cashMatch) {
      const c = new Prisma.Decimal(parseFloat(cashMatch[1]) || 0);
      const k = cardMatch ? new Prisma.Decimal(parseFloat(cardMatch[1]) || 0) : Prisma.Decimal.max(0, total.minus(c));
      cash = c;
      card = k;
    } else {
      const half = total.dividedBy(2).toDecimalPlaces(2);
      cash = half;
      card = total.minus(half);
    }
  }

  return {
    cash: Number(cash.toDecimalPlaces(2)),
    card: Number(card.toDecimalPlaces(2)),
    transfer: Number(transfer.toDecimalPlaces(2)),
    other: Number(other.toDecimalPlaces(2)),
    credit: Number(credit.toDecimalPlaces(2)),
  };
}

