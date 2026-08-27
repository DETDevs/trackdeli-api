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
  pricingModel: PricingModel;
  baseRate: number;
  ratePerKm: number;
  freeZoneKm: number;
  minRate: number;
  maxRate: number;
  pricingZones?: Array<{ id?: string; name: string; price: number }> | null;
  createdAt: Date;
}
