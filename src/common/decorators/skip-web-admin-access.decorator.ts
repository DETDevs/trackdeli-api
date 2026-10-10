import { SetMetadata } from '@nestjs/common';

export const SKIP_WEB_ADMIN_ACCESS_KEY = 'skipWebAdminAccessCheck';

/**
 * 167a: Omite la validación de WebAdminAccessGuard (webAdminEnabled).
 * Permite que rutas operativas de salón/comandero o endpoints públicos
 * funcionen desde clientes web sin verse afectados por el switch de web admin.
 */
export const SkipWebAdminAccess = () => SetMetadata(SKIP_WEB_ADMIN_ACCESS_KEY, true);
