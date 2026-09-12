import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

    return {
      sub: user.id,
      email: user.email,
      role: user.role,
      businessId: user.businessId,
      phone: user.phone,
      vehicleType: user.vehicleType,
      vehiclePlate: user.vehiclePlate,
      vehicleColor: user.vehicleColor,
      vehiclePhotoUrl: user.vehiclePhotoUrl,
      profilePhotoUrl: user.profilePhotoUrl,
      isAvailable: user.isAvailable,
    };
  }
}

