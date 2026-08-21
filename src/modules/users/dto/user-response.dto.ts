import { UserRole } from '@prisma/client';

export class UserResponseDto {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: UserRole;
  isActive: boolean;
  businessId: string;
  createdAt: Date;
}
