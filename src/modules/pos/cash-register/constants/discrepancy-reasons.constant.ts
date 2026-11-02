export const ALLOWED_DISCREPANCY_REASONS = [
  'FALTANTE_CONTEO',
  'SOBRANTE_CAMBIO',
  'ERROR_DE_COBRO',
  'VUELTO_INCORRECTO',
  'GASTO_NO_REGISTRADO',
  'RETIRO_NO_REGISTRADO',
  'OTRO',
] as const;

export type DiscrepancyReason = (typeof ALLOWED_DISCREPANCY_REASONS)[number];

export const DISCREPANCY_REASON_LABELS: Record<DiscrepancyReason, string> = {
  FALTANTE_CONTEO: 'Faltante en conteo',
  SOBRANTE_CAMBIO: 'Sobrante por cambio no reclamado',
  ERROR_DE_COBRO: 'Error de cobro',
  VUELTO_INCORRECTO: 'Vuelto incorrecto',
  GASTO_NO_REGISTRADO: 'Gasto no registrado',
  RETIRO_NO_REGISTRADO: 'Retiro no registrado',
  OTRO: 'Otro motivo (requiere detalle)',
};

