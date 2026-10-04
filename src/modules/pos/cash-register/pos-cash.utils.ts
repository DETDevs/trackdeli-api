import { Prisma } from '@prisma/client';

export interface SalePaymentBreakdown {
  cash: number;
  card: number;
  transfer: number;
  other: number;
  credit: number;
  cashNio: number;
  cashUsd: number;
  cashUsdBase: number;
}

export function getSalePaymentBreakdown(sale: any): SalePaymentBreakdown {
  let cash = new Prisma.Decimal(0);
  let card = new Prisma.Decimal(0);
  let transfer = new Prisma.Decimal(0);
  let other = new Prisma.Decimal(0);
  let credit = new Prisma.Decimal(0);
  let cashNio = new Prisma.Decimal(0);
  let cashUsd = new Prisma.Decimal(0);
  let cashUsdBase = new Prisma.Decimal(0);

  if (sale.payments && Array.isArray(sale.payments) && sale.payments.length > 0) {
    for (const p of sale.payments) {
      const isUsd = (p.currency || '').toUpperCase() === 'USD';
      const changeAmt = new Prisma.Decimal(p.change != null ? p.change.toString() : 0);

      if (p.method === 'EFECTIVO') {
        if (isUsd) {
          const tenderedUsd = new Prisma.Decimal(
            p.amountTendered != null ? p.amountTendered.toString() : (p.amount != null ? p.amount.toString() : 0)
          );
          const rate = new Prisma.Decimal(p.exchangeRate != null ? p.exchangeRate.toString() : 1);
          let baseAmt = p.amountBase != null 
            ? new Prisma.Decimal(p.amountBase.toString()) 
            : new Prisma.Decimal(p.amount != null ? p.amount.toString() : 0).times(rate).toDecimalPlaces(2);

          // Si baseAmt era de un registro previo que aún sumaba lo entregado (baseAmt == tenderedUsd * rate)
          if (changeAmt.greaterThan(0) && baseAmt.equals(tenderedUsd.times(rate).toDecimalPlaces(2))) {
            baseAmt = baseAmt.minus(changeAmt);
          }

          cashUsd = cashUsd.plus(tenderedUsd);
          cashUsdBase = cashUsdBase.plus(baseAmt);
          // El vuelto siempre se da en córdobas, restando de la gaveta de NIO
          cashNio = cashNio.minus(changeAmt);
          // En NIO neto equivalente, entra baseAmt
          cash = cash.plus(baseAmt);
        } else {
          let amtNio = new Prisma.Decimal(p.amount != null ? p.amount.toString() : 0);
          if (p.amountTendered != null && changeAmt.greaterThan(0) && amtNio.equals(new Prisma.Decimal(p.amountTendered.toString()))) {
            amtNio = amtNio.minus(changeAmt);
          }
          cashNio = cashNio.plus(amtNio);
          cash = cash.plus(amtNio);
        }
      } else if (p.method === 'TARJETA') {
        const amt = new Prisma.Decimal(p.amount != null ? p.amount.toString() : 0);
        card = card.plus(amt);
      } else if (p.method === 'TRANSFERENCIA') {
        const amt = new Prisma.Decimal(p.amount != null ? p.amount.toString() : 0);
        transfer = transfer.plus(amt);
      } else if (p.method === 'CREDITO') {
        const amt = new Prisma.Decimal(p.amount != null ? p.amount.toString() : 0);
        credit = credit.plus(amt);
      } else {
        const amt = new Prisma.Decimal(p.amount != null ? p.amount.toString() : 0);
        other = other.plus(amt);
      }
    }

    return {
      cash: Number(cash.toDecimalPlaces(2)),
      card: Number(card.toDecimalPlaces(2)),
      transfer: Number(transfer.toDecimalPlaces(2)),
      other: Number(other.toDecimalPlaces(2)),
      credit: Number(credit.toDecimalPlaces(2)),
      cashNio: Number(cashNio.toDecimalPlaces(2)),
      cashUsd: Number(cashUsd.toDecimalPlaces(2)),
      cashUsdBase: Number(cashUsdBase.toDecimalPlaces(2)),
    };
  }

  // Fallback para datos muy viejos que no hayan pasado por la migración por algún motivo.
  const total = new Prisma.Decimal(sale.total != null ? sale.total.toString() : 0);

  if (sale.paymentMethod === 'EFECTIVO') {
    cash = total;
    cashNio = total;
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
      cashNio = c;
      card = k;
    } else {
      const half = total.dividedBy(2).toDecimalPlaces(2);
      cash = half;
      cashNio = half;
      card = total.minus(half);
    }
  }

  return {
    cash: Number(cash.toDecimalPlaces(2)),
    card: Number(card.toDecimalPlaces(2)),
    transfer: Number(transfer.toDecimalPlaces(2)),
    other: Number(other.toDecimalPlaces(2)),
    credit: Number(credit.toDecimalPlaces(2)),
    cashNio: Number(cashNio.toDecimalPlaces(2)),
    cashUsd: 0,
    cashUsdBase: 0,
  };
}
