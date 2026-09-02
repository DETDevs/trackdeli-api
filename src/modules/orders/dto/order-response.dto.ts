import { DeliveryPaymentStatus, OrderStatus } from '@prisma/client';

export class OrderResponseDto {
  id: string;
  businessId: string;
  status: OrderStatus;
  customerName: string;
  customerPhone: string;
  destinationAddress: string | null;
  destinationLat: number | null;
  destinationLng: number | null;
  geofenceRadiusM: number;
  description: string | null;
  deliveryPaymentStatus: DeliveryPaymentStatus;
  deliveryFee: number;
  distanceKm: number;
  priceNegotiated?: boolean;
  deliveryUser: {
    id: string;
    name: string;
    phone: string | null;
  } | null;
  photos: {
    id: string;
    photoUrl: string;
    type: string;
    createdAt: Date;
  }[];
  trackingToken: string | null;
  trackingUrl?: string | null;
  originBusinessName?: string | null;
  originBusinessClientId?: string | null;
  createdAt: Date;
  activeDispatchTimeoutAt?: Date | null;
  takenAt: Date | null;
  deliveredAt: Date | null;
  business?: {
    id: string;
    name: string;
    latitude: number | null;
    longitude: number | null;
    logoUrl: string | null;
    whatsappNumber?: string | null;
    whatsappDisplay?: string | null;
  };
}
