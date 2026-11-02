import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload): Promise<JwtPayload> {
    if (payload.role === UserRole.WAITER) {
      const waiter = await this.prisma.waiter.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          name: true,
          businessId: true,
          active: true,
        },
      });

      if (!waiter) {
        this.logger.warn(`[validate] Token válido pero mesero inexistente en DB: sub=${payload.sub}`);
        throw new UnauthorizedException('Mesero no encontrado');
      }

      if (!waiter.active) {
        this.logger.warn(`[validate] Intento de acceso de mesero inactivo: id=${waiter.id}`);
        throw new UnauthorizedException('Mesero inactivo');
      }

      return {
        sub: waiter.id,
        email: `${waiter.id}@waiter.trackdeli.com`,
        role: UserRole.WAITER,
        businessId: waiter.businessId,
        waiterName: waiter.name,
        profileComplete: true,
      };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        role: true,
        businessId: true,
        isActive: true,
        phone: true,
        vehicleType: true,
        vehiclePlate: true,
        vehicleColor: true,
        vehiclePhotoUrl: true,
        profilePhotoUrl: true,
        isAvailable: true,
        profileComplete: true,
      },
    });

    if (!user) {
      this.logger.warn(`[validate] Token válido pero usuario inexistente en DB: sub=${payload.sub}`);
      throw new UnauthorizedException('Usuario no encontrado');
    }

    if (!user.isActive) {
      this.logger.warn(`[validate] Intento de acceso de usuario inactivo: id=${user.id}`);
      throw new UnauthorizedException('Usuario inactivo');
    }

    let activeBusinessId = user.businessId;

    if (payload.businessId && payload.businessId !== user.businessId) {
      // 240a: Si el token tiene una sucursal distinta a la principal, validar acceso multi-sucursal
      if (user.role === UserRole.ENCARGADO && user.businessId) {
        const [access, primaryBiz, targetBiz] = await Promise.all([
          this.prisma.userBusinessAccess.findUnique({
            where: {
              userId_businessId: {
                userId: user.id,
                businessId: payload.businessId,
              },
            },
          }),
          this.prisma.business.findUnique({
            where: { id: user.businessId },
            select: { organizationId: true },
          }),
          this.prisma.business.findUnique({
            where: { id: payload.businessId },
            select: { organizationId: true },
          }),
        ]);

        if (
          access &&
          primaryBiz?.organizationId &&
          targetBiz?.organizationId &&
          primaryBiz.organizationId === targetBiz.organizationId
        ) {
          activeBusinessId = payload.businessId;
        } else {
          this.logger.warn(
            `[validate] Intento de acceso a sucursal no autorizada en JWT: sub=${user.id}, target=${payload.businessId}`,
          );
          throw new UnauthorizedException('Acceso no autorizado a la sucursal especificada en el token');
        }
      } else if (user.role === UserRole.SUPERADMIN) {
        activeBusinessId = payload.businessId;
      }
    }

    return {
      sub: user.id,
      email: user.email,
      role: user.role,
      businessId: activeBusinessId || undefined,
      phone: user.phone,
      vehicleType: user.vehicleType,
      vehiclePlate: user.vehiclePlate,
      vehicleColor: user.vehicleColor,
      vehiclePhotoUrl: user.vehiclePhotoUrl,
      profilePhotoUrl: user.profilePhotoUrl,
      isAvailable: user.isAvailable,
      profileComplete: user.profileComplete,
    };
  }
}

