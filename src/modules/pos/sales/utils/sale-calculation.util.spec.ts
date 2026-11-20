import { resolveLineUnitPrice, resolveChannelUnitPrice } from './pricing.util';
import { calculateSaleTotals, isLineBlockedFromManualDiscount } from './sale-calculation.util';

describe('Pricing & Sale Calculation Option A Anti-Stacking (292a)', () => {
  describe('resolveLineUnitPrice & resolveChannelUnitPrice', () => {
    it('aplica prioridad WHOLESALE > PROMO > RETAIL', () => {
      const prod = {
        price: 100,
        wholesalePrice: 75,
        wholesaleMinQty: 6,
        promoDiscountPct: 20,
      };
      const biz = { wholesaleEnabled: true, useListPrice: false };

      expect(resolveLineUnitPrice(prod, 2, biz)).toEqual({
        unitPrice: 80,
        priceTier: 'PROMO',
      });

      expect(resolveLineUnitPrice(prod, 6, biz)).toEqual({
        unitPrice: 75,
        priceTier: 'WHOLESALE',
      });

      expect(resolveLineUnitPrice(prod, 2, { wholesaleEnabled: false, useListPrice: false })).toEqual({
        unitPrice: 80,
        priceTier: 'PROMO',
      });
    });

    it('ignora promoDiscountPct cuando aplica listPrice > price en negocio con useListPrice', () => {
      const prod = {
        price: 90,
        listPrice: 120,
        promoDiscountPct: 15,
      };

      expect(resolveLineUnitPrice(prod, 1, { useListPrice: true })).toEqual({
        unitPrice: 90,
        priceTier: 'RETAIL',
      });

      expect(resolveLineUnitPrice(prod, 1, { useListPrice: false })).toEqual({
        unitPrice: 76.5,
        priceTier: 'PROMO',
      });
    });

    it('excluye promoDiscountPct en canal PEDIDOSYA', () => {
      const prod = {
        price: 100,
        promoDiscountPct: 15,
      };
      const biz = {
        wholesaleEnabled: false,
        useListPrice: false,
        pedidosYaChannelEnabled: true,
        pedidosYaPriceMode: 'MISMO_PRECIO',
        pedidosYaRounding: 'SIN_REDONDEO',
      };

      const mostrador = resolveChannelUnitPrice(prod, 1, biz, 'MOSTRADOR');
      expect(mostrador).toEqual({
        unitPrice: 85,
        priceTier: 'PROMO',
        listPrice: null,
      });

      const pedidosYa = resolveChannelUnitPrice(prod, 1, biz, 'PEDIDOSYA');
      expect(pedidosYa).toEqual({
        unitPrice: 100,
        priceTier: 'RETAIL',
        listPrice: null,
      });
    });
  });

  describe('isLineBlockedFromManualDiscount & calculateSaleTotals (Opción A)', () => {
    it('bloquea descuento manual en WHOLESALE, PROMO, allowDiscount=false y listPrice > unitPrice', () => {
      expect(isLineBlockedFromManualDiscount({ unitPrice: 100, priceTier: 'RETAIL', allowDiscount: true })).toBe(false);
      expect(isLineBlockedFromManualDiscount({ unitPrice: 100, priceTier: 'WHOLESALE', allowDiscount: true })).toBe(true);
      expect(isLineBlockedFromManualDiscount({ unitPrice: 80, priceTier: 'PROMO', allowDiscount: true })).toBe(true);
      expect(isLineBlockedFromManualDiscount({ unitPrice: 100, priceTier: 'RETAIL', allowDiscount: false })).toBe(true);
      expect(
        isLineBlockedFromManualDiscount({ unitPrice: 90, listPrice: 110, priceTier: 'RETAIL', allowDiscount: true }, true),
      ).toBe(true);
      expect(
        isLineBlockedFromManualDiscount({ unitPrice: 90, listPrice: 110, priceTier: 'RETAIL', allowDiscount: true }, false),
      ).toBe(false);
    });

    it('prorratea descuento general solo sobre líneas elegibles sin descuento previo y calcula IVA exacto', () => {
      const summary = calculateSaleTotals(
        [
          // Elegible 1: C$100 x 1 = 100, gravada
          { productId: 'p1', productName: 'Elegible Gravado', unitPrice: 100, quantity: 1, priceTier: 'RETAIL', allowDiscount: true, taxable: true },
          // Elegible 2: C$200 x 1 = 200, exenta
          { productId: 'p2', productName: 'Elegible Exento', unitPrice: 200, quantity: 1, priceTier: 'RETAIL', allowDiscount: true, taxable: false },
          // Ya tiene descuento por línea: C$100 x 1 con desc 20 = neto 80 (no recibe parte del global)
          { productId: 'p3', productName: 'Desc por línea', unitPrice: 100, quantity: 1, discount: 20, priceTier: 'RETAIL', allowDiscount: true, taxable: false },
          // Producto WHOLESALE: C$80 x 5 = 400 (bloqueado; incluso si intentan enviar discount=10 lo ignora)
          { productId: 'p4', productName: 'Mayoreo', unitPrice: 80, quantity: 5, discount: 10, priceTier: 'WHOLESALE', allowDiscount: true, taxable: false },
          // Producto PROMO: C$50 x 2 = 100 (bloqueado)
          { productId: 'p5', productName: 'En oferta', unitPrice: 50, quantity: 2, priceTier: 'PROMO', allowDiscount: true, taxable: true },
          // Producto allowDiscount=false: C$150 x 1 = 150 (bloqueado)
          { productId: 'p6', productName: 'Sin descuento', unitPrice: 150, quantity: 1, priceTier: 'RETAIL', allowDiscount: false, taxable: false },
          // Producto farmacia con etiqueta > unitPrice: C$90 x 1, listPrice 120 (bloqueado)
          { productId: 'p7', productName: 'Etiqueta', unitPrice: 90, quantity: 1, listPrice: 120, priceTier: 'RETAIL', allowDiscount: true, taxable: false },
        ],
        // Piden descuento general de C$60 (aplica 1/3 a Elegible 1 = 20, 2/3 a Elegible 2 = 40)
        60,
        { useListPrice: true },
      );

      expect(summary.eligibleForGlobalDiscountSubtotal).toBe(300);
      expect(summary.lineDiscountTotal).toBe(20);
      expect(summary.discountAmount).toBe(60);
      // Subtotal = 100 + 200 + 80 + 400 + 100 + 150 + 90 = 1120
      expect(summary.subtotal).toBe(1120);
      expect(summary.subtotalBeforeTax).toBe(1060);

      // Prorrateo y bloqueos
      expect(summary.lines[0].manualDiscountShare).toBe(20); // base IVA = 80 -> IVA = 12
      expect(summary.lines[0].taxAmount).toBe(12);
      expect(summary.lines[1].manualDiscountShare).toBe(40);
      expect(summary.lines[2].discount).toBe(20);
      expect(summary.lines[2].manualDiscountShare).toBe(0);
      expect(summary.lines[3].discount).toBe(0);
      expect(summary.lines[3].manualDiscountShare).toBe(0);
      expect(summary.lines[4].manualDiscountShare).toBe(0);
      expect(summary.lines[4].taxAmount).toBe(15); // 100 * 15%
      expect(summary.lines[5].manualDiscountShare).toBe(0);
      expect(summary.lines[6].manualDiscountShare).toBe(0);

      expect(summary.taxAmount).toBe(27);
      expect(summary.total).toBe(1087);
    });

    it('topa el descuento general al subtotal elegible cuando el monto solicitado lo supera', () => {
      const summary = calculateSaleTotals(
        [
          { productId: 'p1', productName: 'A', unitPrice: 50, quantity: 1, priceTier: 'RETAIL', taxable: false },
          { productId: 'p2', productName: 'B', unitPrice: 100, quantity: 1, priceTier: 'PROMO', taxable: false },
        ],
        120,
        { useListPrice: false },
      );

      expect(summary.eligibleForGlobalDiscountSubtotal).toBe(50);
      expect(summary.discountAmount).toBe(50);
      expect(summary.subtotalBeforeTax).toBe(100);
      expect(summary.total).toBe(100);
    });
  });
});
