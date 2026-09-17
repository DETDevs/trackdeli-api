import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessProductType, UserRole } from '@prisma/client';
import { BusinessProductsService } from '../../modules/business-products/business-products.service';

@Injectable()
export class CarteraCobroGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly businessProductsService: BusinessProductsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('No autenticado');
    }

    if (user.role === UserRole.REPARTIDOR) {
      throw new ForbiddenException(
        'Acceso denegado - el modulo de Cartera de Cobro no esta disponible para repartidores',
      );
    }

    // Resolver businessId desde usuario o query (para SuperAdmin) o params
    let businessId: string | undefined = user.businessId;

    if (user.role === UserRole.SUPERADMIN) {
      if (request.query?.businessId) {
        businessId = request.query.businessId as string;
      } else if (request.params?.businessId) {
        businessId = request.params.businessId as string;
      }
    }

    // Si aún no tenemos businessId y la ruta tiene un parámetro :id (creditAccountId o customerId)
    if (!businessId && request.params?.id) {
      // Buscar primero si corresponde a una cuenta de crédito
      const acc = await this.prisma.creditAccount.findUnique({
        where: { id: request.params.id },
        select: { businessId: true },
      });
      if (acc) {
        businessId = acc.businessId;
      } else {
        // Buscar si corresponde a un cliente
        const cust = await this.prisma.customer.findUnique({
          where: { id: request.params.id },
          select: { businessId: true },
        });
        if (cust) {
          businessId = cust.businessId;
        }
      }
    }

    if (!businessId) {
      if (user.role === UserRole.SUPERADMIN) {
        throw new BadRequestException(
          'Debe especificar el parámetro ?businessId=xxx para consultar este recurso de Cartera de Cobro como SuperAdmin.',
        );
      }
      throw new ForbiddenException('Sin negocio asociado');
    }

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { isActive: true },
    });

    if (!business?.isActive) {
      throw new ForbiddenException('Negocio inactivo');
    }

    const isCarteraActive = await this.businessProductsService.isActive(
      businessId,
      BusinessProductType.CARTERA_COBRO,
    );

    if (!isCarteraActive) {
      throw new ForbiddenException('Este negocio no tiene Cartera de Cobro contratada');
    }

    return true;
  }
}
