export class BusinessResponseDto {
  id: string;
  name: string;
  type: string | null;
  logoUrl: string | null;
  defaultGeofenceRadiusM: number;
  createdAt: Date;
}
