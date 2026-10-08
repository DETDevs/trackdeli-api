export const SALON_PROFILES = {
  RESTAURANTE: 'RESTAURANTE',
  TALLER: 'TALLER',
} as const;

export type SalonProfileType = (typeof SALON_PROFILES)[keyof typeof SALON_PROFILES];

export interface SalonProfileLabels {
  salon: string;
  zone: string;
  table: string;
  tables: string;
  waiter: string;
}

export const SALON_PROFILE_LABELS: Record<SalonProfileType, SalonProfileLabels> = {
  RESTAURANTE: {
    salon: 'Salón',
    zone: 'Zona',
    table: 'Mesa',
    tables: 'Mesas',
    waiter: 'Mesero',
  },
  TALLER: {
    salon: 'Taller',
    zone: 'Área',
    table: 'Vehículo',
    tables: 'Vehículos',
    waiter: 'Técnico',
  },
};

export function resolveSalonProfile(profile?: string | null): SalonProfileType {
  if (profile && profile.toUpperCase() === 'TALLER') {
    return 'TALLER';
  }
  return 'RESTAURANTE';
}

export function getSalonLabels(profile?: string | null): SalonProfileLabels {
  const resolved = resolveSalonProfile(profile);
  return SALON_PROFILE_LABELS[resolved];
}
