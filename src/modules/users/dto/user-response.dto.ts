import { UserRole } from '@prisma/client';

export class UserResponseDto {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: UserRole;
  isActive: boolean;
  businessId: string;
  vehicleType: string | null;
  vehiclePlate: string | null;
  vehicleColor: string | null;
  vehiclePhotoUrl: string | null;
  profilePhotoUrl: string | null;
  isAvailable: boolean;
  createdAt: Date;
}
