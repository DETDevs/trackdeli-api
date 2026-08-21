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
  };
}
