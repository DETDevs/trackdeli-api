import { PricingModel } from '@prisma/client';

export class BusinessResponseDto {
  id: string;
  name: string;
  type: string | null;
  logoUrl: string | null;
  defaultGeofenceRadiusM: number;
  latitude: number | null;
  longitude: number | null;
  isActive: boolean;

  // Módulos activos
  hasTrackDeli: boolean;
  hasPOS: boolean;

  // Precios TrackDeli
  pricingModel: PricingModel;
  baseRate: number;
  ratePerKm: number;
  freeZoneKm: number;
  minRate: number;
  maxRate: number;
  pricingZones?: Array<{ id?: string; name: string; price: number }> | null;

  // Contacto
  whatsappNumber?: string | null;
  whatsappDisplay?: string | null;

  // Configuración POS
  taxRate: number;
  currency: string;
  invoicePrefix: string;
  invoiceCounter: number;
  posAddress?: string | null;
  posPhone?: string | null;
  posFooter?: string | null;

  createdAt: Date;
}
