import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { BusinessProductType, UserRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { BusinessProductsService } from '../../business-products/business-products.service';

/**
 * 320a — Guard del módulo de preventa (/pos/preventa/*).
 * - Sin WebBillingGuard: los celulares de vendedores nunca consumen cupo de navegadores.
 * - PREVENTA inactivo o vencido:
 *     - PREVENTISTA: 403 PREVENTA_INACTIVE en cualquier método (GET incluido).
 *     - ENCARGADO / SUPERADMIN: solo lectura (GET pasa; POST/PATCH/PUT/DELETE -> 403 PREVENTA_INACTIVE).
 */
@Injectable()
export class PreventaGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly businessProductsService: BusinessProductsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'NOT_AUTHENTICATED',
        message: 'Debes iniciar sesión para continuar.',
      });
    }

    const allowedRoles: UserRole[] = [
      UserRole.PREVENTISTA,
      UserRole.ENCARGADO,
      UserRole.SUPERADMIN,
    ];
    if (!allowedRoles.includes(user.role)) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'PREVENTA_ROLE_FORBIDDEN',
        message: 'Tu rol no tiene acceso al módulo de preventa.',
      });
    }

    const businessId =
      user.role === UserRole.SUPERADMIN
        ? request.query?.businessId || user.businessId
        : user.businessId;

    if (!businessId) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'NO_BUSINESS',
        message: 'No tenés un negocio asociado.',
      });
    }

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, isActive: true },
    });

    if (!business?.isActive) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'BUSINESS_INACTIVE',
        message: 'El negocio está inactivo.',
      });
    }

    const isPreventaActive = await this.businessProductsService.isActive(
      businessId,
      BusinessProductType.PREVENTA,
    );

    if (!isPreventaActive) {
      if (user.role === UserRole.PREVENTISTA) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'PREVENTA_INACTIVE',
          message: 'El módulo de preventa no está activo en este negocio. Hablá con tu encargado.',
        });
      }

      const method = (request.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'PREVENTA_INACTIVE',
          message: 'El módulo de preventa está inactivo o vencido. Solo tenés acceso de lectura.',
        });
      }
    }

    return true;
  }
}
