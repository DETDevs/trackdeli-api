export class CustomerResponseDto {
  id: string;
  businessId: string;
  name: string;
  phone: string;
  ruc?: string | null;
  creditLimit?: number | null;
  groupId?: string | null;
  group?: { id: string; name: string; taxId?: string | null } | null;
  externalCode?: string | null;
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
  ruc?: string | null;
  creditLimit?: number | null;
  groupId?: string | null;
  externalCode?: string | null;
  lastLatitude: number | null;
  lastLongitude: number | null;
  lastAddressText: string | null;
  lastConfirmedAt: Date | null;
  isLocationRecent: boolean;
}

export class CustomerLocationConfirmationLinkDto {
  customerId: string;
  token: string;
  shortCode?: string;
  url: string;
  confirmationUrl: string;
  whatsappUrl?: string;
  expiresAt: Date;
  autoSent?: boolean;
}

export class CustomerLocationSessionPublicDto {
  valid: boolean;
  expired: boolean;
  sessionStatus?: 'PENDING' | 'RESPONDED';
  status?: string;
  respondedAt?: Date | null;
  token?: string;
  shortCode?: string;
  customerId?: string;
  name?: string;
  phone?: string;
  lastLatitude?: number | null;
  lastLongitude?: number | null;
  lastAddressText?: string | null;
  lastConfirmedAt?: Date | null;
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
