import { PricingModel } from '@prisma/client';

export function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371; // Radio de la Tierra en km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // distancia en km
}

export function calculateDeliveryFee(
  business: {
    pricingModel: PricingModel;
    baseRate: number;
    ratePerKm: number;
    freeZoneKm: number;
    minRate: number;
    maxRate: number;
    latitude: number | null;
    longitude: number | null;
  },
  destLat: number,
  destLng: number,
): { fee: number; distanceKm: number; breakdown: string } {
  // Si el negocio no tiene ubicación configurada, no se puede calcular
  if (!business.latitude || !business.longitude) {
    return { fee: 0, distanceKm: 0, breakdown: 'Sin ubicación del negocio' };
  }

  const distanceKm = haversineDistance(
    business.latitude,
    business.longitude,
    destLat,
    destLng,
  );

  let fee = 0;
  let breakdown = '';

  switch (business.pricingModel) {
    case PricingModel.FREE:
      fee = 0;
      breakdown = 'Envío gratis';
      break;

    case PricingModel.RIDER_QUOTE:
      fee = 0;
      breakdown = 'Propuesta de repartidor (tarifa a negociar)';
      break;

    case PricingModel.FIXED:
      fee = business.baseRate;
      breakdown = `Tarifa fija: C$${fee.toFixed(2)}`;
      break;

    case PricingModel.PER_KM:
      // Si está dentro de la zona gratis, no cobra
      if (business.freeZoneKm > 0 && distanceKm <= business.freeZoneKm) {
        fee = 0;
        breakdown = `Dentro de zona gratis (${distanceKm.toFixed(1)} km)`;
      } else {
        // Distancia efectiva (restando la zona gratis si aplica)
        const effectiveKm = Math.max(0, distanceKm - business.freeZoneKm);
        fee = business.baseRate + effectiveKm * business.ratePerKm;
        breakdown = `C$${business.baseRate} base + ${effectiveKm.toFixed(1)} km × C$${business.ratePerKm}/km`;
      }

      // Aplicar mínimo y máximo
      if (business.minRate > 0) {
        fee = Math.max(fee, business.minRate);
      }
      if (business.maxRate > 0) {
        fee = Math.min(fee, business.maxRate);
      }
      break;
  }

  return {
    fee: Math.round(fee * 100) / 100, // redondear a 2 decimales
    distanceKm: Math.round(distanceKm * 100) / 100,
    breakdown,
  };
}
