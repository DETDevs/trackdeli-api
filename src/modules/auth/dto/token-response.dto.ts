import { UserRole } from '@prisma/client';

export class TokenResponseDto {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    name: string;
    email: string;
    role: UserRole;
    businessId: string;
    phone?: string | null;
    vehicleType?: string | null;
    vehiclePlate?: string | null;
    vehicleColor?: string | null;
    vehiclePhotoUrl?: string | null;
    profilePhotoUrl?: string | null;
    isAvailable?: boolean;
  };
}
