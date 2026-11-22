export const PROMOTION_TYPES = [
  'PERCENT_DISCOUNT',
  'FIXED_DISCOUNT',
  'BUY_N_PAY_M',
  'QTY_PRICE_TIER',
] as const;

export type PromotionType = (typeof PROMOTION_TYPES)[number];

export const PROMOTION_SCOPES = ['PRODUCT', 'CATEGORY'] as const;

export type PromotionScope = (typeof PROMOTION_SCOPES)[number];

export const PROMOTION_CHANNELS = ['MOSTRADOR', 'DOMICILIO', 'PEDIDOSYA'] as const;

export type PromotionChannel = (typeof PROMOTION_CHANNELS)[number];

export interface PromotionRule {
  id: string;
  name: string;
  type: string;
  scope: string;
  productIds?: any;
  categoryIds?: any;
  discountPct?: any;
  discountAmount?: any;
  buyQty?: number | null;
  payQty?: number | null;
  minQty?: any;
  tierUnitPrice?: any;
  startsAt?: Date | string | null;
  endsAt?: Date | string | null;
  daysOfWeek?: any;
  startTime?: string | null;
  endTime?: string | null;
  channels?: any;
  priority?: number | null;
  isActive: boolean;
  createdAt?: Date | string | null;
}

export interface PromotionCartLineInput {
  productId?: string | null;
  parentProductId?: string | null;
  categoryId?: string | null;
  presentationId?: string | null;
  quantity: number;
  retailUnitPrice: number;
  unitAllowsDecimals: boolean;
  wholesaleUnitPrice?: number | null;
}

export interface LinePromotionDecision {
  applied: boolean;
  promotionId: string | null;
  promotionName: string | null;
  promoDiscountCents: number;
  promoDiscount: number;
  winner: 'DYNAMIC_PROMO' | 'WHOLESALE' | 'NONE';
}

const WEEKDAY_SHORT_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function toStringArray(raw: any): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => String(v ?? '').trim()).filter(Boolean);
}

export function toIntArray(raw: any): number[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
}

export function getManaguaDayAndMinutes(now: Date): {
  dayOfWeek: number;
  minutesOfDay: number;
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Managua',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const map: Record<string, string> = {};
  for (const part of parts) {
    map[part.type] = part.value;
  }
  const dayOfWeek = WEEKDAY_SHORT_MAP[map.weekday] ?? 0;
  let hour = Number(map.hour || 0);
  if (hour === 24) hour = 0;
  const minute = Number(map.minute || 0);
  return {
    dayOfWeek,
    minutesOfDay: hour * 60 + minute,
  };
}

export function parseTimeToMinutes(timeStr: string | null | undefined): number | null {
  if (!timeStr) return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(timeStr).trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function isPromotionActiveAt(
  promo: PromotionRule,
  now: Date = new Date(),
  channel?: string | null,
): boolean {
  if (!promo || !promo.isActive) return false;

  const nowMs = now.getTime();
  if (promo.startsAt) {
    const startMs = new Date(promo.startsAt).getTime();
    if (!Number.isFinite(startMs) || nowMs < startMs) return false;
  }
  if (promo.endsAt) {
    const endMs = new Date(promo.endsAt).getTime();
    if (!Number.isFinite(endMs) || nowMs > endMs) return false;
  }

  const days = toIntArray(promo.daysOfWeek);
  const startMin = parseTimeToMinutes(promo.startTime);
  const endMin = parseTimeToMinutes(promo.endTime);

  if (days.length > 0 || startMin !== null || endMin !== null) {
    const { dayOfWeek, minutesOfDay } = getManaguaDayAndMinutes(now);
    if (days.length > 0 && !days.includes(dayOfWeek)) {
      return false;
    }
    if (startMin !== null && endMin !== null) {
      if (startMin <= endMin) {
        if (minutesOfDay < startMin || minutesOfDay > endMin) return false;
      } else {
        // Rango que cruza medianoche
        if (minutesOfDay < startMin && minutesOfDay > endMin) return false;
      }
    } else if (startMin !== null && minutesOfDay < startMin) {
      return false;
    } else if (endMin !== null && minutesOfDay > endMin) {
      return false;
    }
  }

  if (channel) {
    const allowedChannels = toStringArray(promo.channels).map((c) => c.toUpperCase());
    if (allowedChannels.length > 0 && !allowedChannels.includes(channel.toUpperCase())) {
      return false;
    }
  }

  return true;
}

function calculateCandidatePromoDiscountCents(
  promo: PromotionRule,
  line: PromotionCartLineInput,
  unitPriceCents: number,
  grossLineCents: number,
): number {
  const qty = Number(line.quantity || 0);
  if (qty <= 0 || grossLineCents <= 0) return 0;

  switch (promo.type) {
    case 'PERCENT_DISCOUNT': {
      const pct = Number(promo.discountPct || 0);
      if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) return 0;
      return Math.min(grossLineCents, Math.round(grossLineCents * (pct / 100)));
    }
    case 'FIXED_DISCOUNT': {
      const amt = Number(promo.discountAmount || 0);
      if (!Number.isFinite(amt) || amt <= 0) return 0;
      return Math.min(grossLineCents, Math.round(amt * qty * 100));
    }
    case 'BUY_N_PAY_M': {
      // NxM solo aplica al mismo producto y en unidades sin decimales
      if (line.unitAllowsDecimals || !Number.isInteger(qty)) return 0;
      const buyQty = Number(promo.buyQty || 0);
      const payQty = Number(promo.payQty || 0);
      if (
        !Number.isInteger(buyQty) ||
        !Number.isInteger(payQty) ||
        payQty < 1 ||
        buyQty <= payQty ||
        qty < buyQty
      ) {
        return 0;
      }
      const freeUnits = Math.floor(qty / buyQty) * (buyQty - payQty);
      return Math.min(grossLineCents, freeUnits * unitPriceCents);
    }
    case 'QTY_PRICE_TIER': {
      const minQty = Number(promo.minQty || 0);
      const tierUnitPrice =
        promo.tierUnitPrice != null ? Number(promo.tierUnitPrice) : -1;
      if (
        !Number.isFinite(minQty) ||
        minQty <= 0 ||
        !Number.isFinite(tierUnitPrice) ||
        tierUnitPrice < 0 ||
        qty < minQty
      ) {
        return 0;
      }
      const targetCents = Math.round(tierUnitPrice * qty * 100);
      return Math.max(0, grossLineCents - targetCents);
    }
    default:
      return 0;
  }
}

export function evaluateLinePromotion(
  line: PromotionCartLineInput,
  activePromotions: PromotionRule[],
): LinePromotionDecision {
  const hasWholesale =
    line.wholesaleUnitPrice !== undefined &&
    line.wholesaleUnitPrice !== null &&
    Number(line.wholesaleUnitPrice) > 0;

  // Presentaciones (294b) y líneas libres sin productId no reciben promociones
  if (!line.productId || line.presentationId || line.quantity <= 0) {
    return {
      applied: false,
      promotionId: null,
      promotionName: null,
      promoDiscountCents: 0,
      promoDiscount: 0,
      winner: hasWholesale ? 'WHOLESALE' : 'NONE',
    };
  }

  const unitPriceCents = Math.max(0, Math.round(line.retailUnitPrice * 100));
  const grossLineCents = Math.max(0, Math.round(line.retailUnitPrice * line.quantity * 100));

  const candidates: Array<{ promo: PromotionRule; discountCents: number }> = [];

  for (const promo of activePromotions) {
    if (promo.scope === 'PRODUCT') {
      const pIds = toStringArray(promo.productIds);
      const matchesProduct =
        pIds.includes(line.productId) ||
        (line.parentProductId != null && pIds.includes(line.parentProductId));
      if (!matchesProduct) continue;
    } else if (promo.scope === 'CATEGORY') {
      const cIds = toStringArray(promo.categoryIds);
      if (!line.categoryId || !cIds.includes(line.categoryId)) continue;
    } else {
      continue;
    }

    const discountCents = calculateCandidatePromoDiscountCents(
      promo,
      line,
      unitPriceCents,
      grossLineCents,
    );
    if (discountCents > 0) {
      candidates.push({ promo, discountCents });
    }
  }

  if (candidates.length === 0) {
    return {
      applied: false,
      promotionId: null,
      promotionName: null,
      promoDiscountCents: 0,
      promoDiscount: 0,
      winner: hasWholesale ? 'WHOLESALE' : 'NONE',
    };
  }

  // Mayor prioridad gana; en empate, mayor ahorro; desempate determinista por createdAt/id
  candidates.sort((a, b) => {
    const prioDiff = Number(b.promo.priority || 0) - Number(a.promo.priority || 0);
    if (prioDiff !== 0) return prioDiff;
    const discDiff = b.discountCents - a.discountCents;
    if (discDiff !== 0) return discDiff;
    const aCreated = a.promo.createdAt ? new Date(a.promo.createdAt).getTime() : 0;
    const bCreated = b.promo.createdAt ? new Date(b.promo.createdAt).getTime() : 0;
    if (aCreated !== bCreated) return aCreated - bCreated;
    return String(a.promo.id).localeCompare(String(b.promo.id));
  });

  const best = candidates[0];

  // Mayoreo contra promoción: gana el precio total más bajo para el cliente
  if (hasWholesale) {
    const wholesaleLineCents = Math.max(
      0,
      Math.round(Number(line.wholesaleUnitPrice) * line.quantity * 100),
    );
    const promoLineCents = Math.max(0, grossLineCents - best.discountCents);
    if (wholesaleLineCents <= promoLineCents) {
      return {
        applied: false,
        promotionId: null,
        promotionName: null,
        promoDiscountCents: 0,
        promoDiscount: 0,
        winner: 'WHOLESALE',
      };
    }
  }

  return {
    applied: true,
    promotionId: best.promo.id,
    promotionName: best.promo.name,
    promoDiscountCents: best.discountCents,
    promoDiscount: best.discountCents / 100,
    winner: 'DYNAMIC_PROMO',
  };
}

export function evaluateCartPromotions(
  lines: PromotionCartLineInput[],
  promotions: PromotionRule[],
  options?: { now?: Date; channel?: string | null },
): LinePromotionDecision[] {
  const now = options?.now ?? new Date();
  const channel = options?.channel ?? null;
  const activePromotions = (promotions || []).filter((p) =>
    isPromotionActiveAt(p, now, channel),
  );
  return lines.map((line) => evaluateLinePromotion(line, activePromotions));
}
