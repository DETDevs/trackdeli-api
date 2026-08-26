import { UserRole } from '@prisma/client';

export interface JwtPayload {
  sub: string;        // userId
  email: string;
  role: UserRole;
  businessId: string | null;
  phone?: string | null;
  vehicleType?: string | null;
  vehiclePlate?: string | null;
  vehicleColor?: string | null;
  vehiclePhotoUrl?: string | null;
  profilePhotoUrl?: string | null;
  isAvailable?: boolean;
  iat?: number;
  exp?: number;
}
