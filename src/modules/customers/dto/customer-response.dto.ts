export class CustomerResponseDto {
  id: string;
  businessId: string;
  name: string;
  phone: string;
  lastLatitude: number | null;
  lastLongitude: number | null;
  lastAddressText: string | null;
  lastConfirmedAt: Date | null;
  isLocationRecent?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export class CustomerSearchResultDto {
  id: string;
  name: string;
  phone: string;
  lastLatitude: number | null;
  lastLongitude: number | null;
  lastAddressText: string | null;
  lastConfirmedAt: Date | null;
  isLocationRecent: boolean;
}

export class CustomerLocationConfirmationLinkDto {
  token: string;
  url: string;
  expiresAt: Date;
}

export class CustomerLocationSessionPublicDto {
  valid: boolean;
  customer?: {
    id: string;
    name: string;
    phone: string;
    lastLatitude: number | null;
    lastLongitude: number | null;
    lastAddressText: string | null;
    lastConfirmedAt: Date | null;
  };
  business?: {
    id: string;
    name: string;
    logoUrl: string | null;
  };
}
