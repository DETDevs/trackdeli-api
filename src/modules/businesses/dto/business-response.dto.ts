import { BusinessType, PosVertical, PricingModel } from '@prisma/client';

export class BusinessResponseDto {
  id: string;
  name: string;
  type: string | null;
  logoUrl: string | null;
  defaultGeofenceRadiusM: number;
  latitude: number | null;
  longitude: number | null;
  isActive: boolean;

  businessType: BusinessType;
  commissionRate: number;
  altCommissionRate: number;
  altCommissionDistanceKm: number;
  dispatchTimeoutMin: number;

  hasTrackDeli: boolean;
  hasPOS: boolean;

  posVertical: PosVertical;
  gridColumns: number;
  gridRows: number;

  pricingModel: PricingModel;
  baseRate: number;
  ratePerKm: number;
  freeZoneKm: number;
  minRate: number;
  maxRate: number;
  pricingZones?: Array<{ id?: string; name: string; price: number }> | null;

  whatsappNumber?: string | null;
  whatsappDisplay?: string | null;

  taxRate: number;
  currency: string;
  invoicePrefix: string;
  invoiceCounter: number;
  posAddress?: string | null;
  posPhone?: string | null;
  posFooter?: string | null;

  createdAt: Date;
}

