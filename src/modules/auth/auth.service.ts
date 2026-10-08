import { Injectable, UnauthorizedException, Logger, NotFoundException, ConflictException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { LoginDto } from './dto/login.dto';
import { TokenResponseDto } from './dto/token-response.dto';
import { RegisterRiderDto } from './dto/register-rider.dto';
import { SocialLoginDto } from './dto/social-login.dto';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { User, AuthProvider, BusinessProductType, UserRole } from '@prisma/client';
import { FirebaseService } from '../notifications/firebase.service';
import { PosDevicesService } from '../pos/devices/pos-devices.service';
import { getSalonLabels, resolveSalonProfile } from '../pos/salon/salon-profile.util';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private firebaseService: FirebaseService,
    private posDevicesService: PosDevicesService,
  ) {}

  async validateUser(email: string, password: string): Promise<User | null> {
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      this.logger.warn(`[validateUser] WARN usuario no encontrado: ${email}`);
      return null;
    }

    if (user.authProvider !== AuthProvider.EMAIL && !user.passwordHash) {
      this.logger.warn(`[validateUser] WARN intento de login con contraseña en cuenta social: ${email}`);
      throw new UnauthorizedException('Esta cuenta fue creada con redes sociales. Por favor, inicia sesión con Google o Apple.');
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash || '');
    if (!isPasswordValid) {
      this.logger.warn(`[validateUser] WARN password incorrecta: ${email}`);
      return null;
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Usuario inactivo');
    }

    return user;
  }

  async login(dto: LoginDto, req?: any): Promise<TokenResponseDto> {
    const user = await this.validateUser(dto.email, dto.password);

    if (!user) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    let posSub: any = null;
    let trialData: { endsAt: string | null; serverNow: string; remainingSeconds: number | null } | null = null;
    let maxExpiresAt: Date | null = null;

    if (user.businessId && user.role !== UserRole.SUPERADMIN) {
      posSub = await this.prisma.businessProductSubscription.findUnique({
        where: {
          businessId_productType: {
            businessId: user.businessId,
            productType: BusinessProductType.POS,
          },
        },
      });

      if (posSub && posSub.trialHours !== null && posSub.trialHours >= 1) {
        const now = new Date();

        if (posSub.trialEndsAt && now >= posSub.trialEndsAt) {
          this.logger.warn(`[login] Rechazado por prueba vencida: businessId=${user.businessId}, email=${dto.email}`);
          throw new ForbiddenException({
            statusCode: 403,
            error: 'Forbidden',
            code: 'TRIAL_EXPIRED',
            message: 'La prueba de este negocio terminó. Contactá a NEXOL para continuar.',
          });
        }

        const headers = req?.headers || {};
        const platformRaw = headers['x-client-platform'] || headers['X-Client-Platform'];
        const isDesktopWin = String(platformRaw || '').trim().toLowerCase() === 'desktop-win';

        if (isDesktopWin && !posSub.trialStartedAt) {
          const trialStartedAt = now;
          const trialEndsAt = new Date(now.getTime() + posSub.trialHours * 60 * 60 * 1000);
          posSub = await this.prisma.businessProductSubscription.update({
            where: { id: posSub.id },
            data: {
              trialStartedAt,
              trialEndsAt,
            },
          });
          this.logger.log(
            `[login] Reloj de prueba iniciado para businessId=${user.businessId}: ${posSub.trialHours}h hasta ${trialEndsAt.toISOString()}`,
          );
        }

        if (posSub.trialEndsAt) {
          maxExpiresAt = posSub.trialEndsAt;
        }

        const serverNow = new Date();
        const remainingSeconds = posSub.trialEndsAt
          ? Math.max(0, Math.floor((posSub.trialEndsAt.getTime() - serverNow.getTime()) / 1000))
          : posSub.trialHours * 3600;

        trialData = {
          endsAt: posSub.trialEndsAt ? posSub.trialEndsAt.toISOString() : null,
          serverNow: serverNow.toISOString(),
          remainingSeconds,
        };
      }
    }

    // 132a — Control de dispositivos POS
    await this.posDevicesService.validateAndRegisterOnLogin(user, req);

    this.logger.log(`[login] OK email=${dto.email}, rol=${user.role}`);

    const payload: JwtPayload = {
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
          profileComplete: user.profileComplete,
    };

    const tokens = this.generateTokens(payload, maxExpiresAt);

    let businessData: any = null;
    let salonProfile = 'RESTAURANTE';
    let salonLabels = getSalonLabels('RESTAURANTE');
    if (user.businessId) {
      const b = await this.prisma.business.findUnique({
        where: { id: user.businessId },
        select: { id: true, name: true, salonProfile: true, posVertical: true },
      });
      if (b) {
        salonProfile = resolveSalonProfile(b.salonProfile);
        salonLabels = getSalonLabels(salonProfile);
        businessData = {
          id: b.id,
          name: b.name,
          salonProfile,
          salonLabels,
          posVertical: b.posVertical,
        };
      }
    }

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        name: user.name,
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
        profileComplete: user.profileComplete,
        business: businessData,
        salonProfile,
        salonLabels,
      },
      trial: trialData,
    };
  }

  async socialLogin(dto: SocialLoginDto): Promise<TokenResponseDto> {
    try {
      const decodedToken = await this.firebaseService.verifyIdToken(dto.idToken);
      const email = decodedToken.email;
      const name = decodedToken.name || 'Usuario';

      if (!email) {
        throw new BadRequestException('El token de autenticación no contiene un correo electrónico');
      }

      let user = await this.prisma.user.findUnique({
        where: { email },
      });

      if (!user) {
        // Create new user
        user = await this.prisma.user.create({
          data: {
            email,
            name,
            authProvider: AuthProvider[dto.provider],
            role: 'REPARTIDOR',
            profileComplete: false,
            isAvailable: true,
          },
        });
        this.logger.log(`[socialLogin] OK nuevo usuario: ${email} via ${dto.provider}`);
      } else {
        // Update provider if it was email (implicit link) or just allow login
        this.logger.log(`[socialLogin] OK usuario existente: ${email} via ${dto.provider}`);
      }

      const payload: JwtPayload = {
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
        profileComplete: user.profileComplete,
      };

      const tokens = this.generateTokens(payload);

      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: {
          id: user.id,
          name: user.name,
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
          profileComplete: user.profileComplete,
        },
      };

    } catch (error: any) {
      this.logger.error(`[socialLogin] ERROR verificando token: ${error.message}`);
      throw new UnauthorizedException('Token de autenticación inválido');
    }
  }

  async registerRider(dto: RegisterRiderDto): Promise<TokenResponseDto> {
    try {
      let businessId: string | null = null;
      let inviteCodeRecord: any = null;

      if (dto.inviteCode) {
        inviteCodeRecord = await this.prisma.inviteCode.findUnique({
          where: { code: dto.inviteCode.trim().toUpperCase() },
        });

        if (!inviteCodeRecord || !inviteCodeRecord.isActive) {
          throw new BadRequestException('Código de invitación inválido o inactivo');
        }

        if (inviteCodeRecord.expiresAt && new Date() > inviteCodeRecord.expiresAt) {
          throw new BadRequestException('El código de invitación ha expirado');
        }

        if (
          inviteCodeRecord.maxUses &&
          inviteCodeRecord.usedCount >= inviteCodeRecord.maxUses
        ) {
          throw new BadRequestException('El código ha alcanzado el límite de usos');
        }

        businessId = inviteCodeRecord.businessId;
      }

      const passwordHash = await bcrypt.hash(dto.password, 10);

      const user = await this.prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            email: dto.email,
            passwordHash,
            name: dto.name,
            phone: dto.phone,
            role: 'REPARTIDOR',
            businessId,
            isAvailable: true,
            vehicleType: dto.vehicleType,
            vehiclePlate: dto.vehiclePlate,
            vehicleColor: dto.vehicleColor,
          },
        });

        if (inviteCodeRecord) {
          await tx.inviteCodeUsage.create({
            data: {
              inviteCodeId: inviteCodeRecord.id,
              riderId: newUser.id,
            },
          });

          await tx.inviteCode.update({
            where: { id: inviteCodeRecord.id },
            data: { usedCount: { increment: 1 } },
          });
        }

        return newUser;
      });

      this.logger.log(
        `[register] OK nuevo repartidor: ${dto.email} → empresa: ${businessId ?? 'independiente'}`,
      );

      const payload: JwtPayload = {
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
        profileComplete: user.profileComplete,
      };

      const tokens = this.generateTokens(payload);

      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: {
          id: user.id,
          name: user.name,
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
          profileComplete: user.profileComplete,
        },
      };
    } catch (error: any) {
      if (error instanceof BadRequestException || error instanceof ConflictException) {
        throw error;
      }
      if (error.code === 'P2002') {
        this.logger.warn(`[register] WARN email ya existe: ${dto.email}`);
        throw new ConflictException('El correo electrónico ya está en uso');
      }
      this.logger.error(`[register] ERROR: ${error.message}`, error.stack);
      throw error;
    }
  }

  async refresh(refreshToken: string): Promise<TokenResponseDto> {
    try {
      const decoded = this.jwtService.verify(refreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });

      this.logger.log(`[refresh] Intento de refresh — userId=${decoded?.sub}`);

      const user = await this.prisma.user.findUnique({
        where: { id: decoded.sub },
      });

      if (!user || !user.isActive) {
        throw new UnauthorizedException('Usuario no válido o inactivo');
      }

      let posSub: any = null;
      let trialData: { endsAt: string | null; serverNow: string; remainingSeconds: number | null } | null = null;
      let maxExpiresAt: Date | null = null;

      if (user.businessId && user.role !== UserRole.SUPERADMIN) {
        posSub = await this.prisma.businessProductSubscription.findUnique({
          where: {
            businessId_productType: {
              businessId: user.businessId,
              productType: BusinessProductType.POS,
            },
          },
        });

        if (posSub && posSub.trialHours !== null && posSub.trialHours >= 1) {
          const now = new Date();

          if (posSub.trialEndsAt && now >= posSub.trialEndsAt) {
            this.logger.warn(`[refresh] Rechazado por prueba vencida: businessId=${user.businessId}, userId=${user.id}`);
            throw new ForbiddenException({
              statusCode: 403,
              error: 'Forbidden',
              code: 'TRIAL_EXPIRED',
              message: 'La prueba de este negocio terminó. Contactá a NEXOL para continuar.',
            });
          }

          if (posSub.trialEndsAt) {
            maxExpiresAt = posSub.trialEndsAt;
          }

          const serverNow = new Date();
          const remainingSeconds = posSub.trialEndsAt
            ? Math.max(0, Math.floor((posSub.trialEndsAt.getTime() - serverNow.getTime()) / 1000))
            : posSub.trialHours * 3600;

          trialData = {
            endsAt: posSub.trialEndsAt ? posSub.trialEndsAt.toISOString() : null,
            serverNow: serverNow.toISOString(),
            remainingSeconds,
          };
        }
      }

      const payload: JwtPayload = {
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
        profileComplete: user.profileComplete,
      };

      const tokens = this.generateTokens(payload, maxExpiresAt);

      this.logger.log(`[refresh] OK — userId=${user.id}, nuevos tokens generados`);

      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: {
          id: user.id,
          name: user.name,
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
          profileComplete: user.profileComplete,
        },
        trial: trialData,
      };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }
      this.logger.warn(`[refresh] WARN — token inválido: ${error.message}`);
      throw new UnauthorizedException('Refresh token inválido o expirado');
    }
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        businessId: true,
        vehicleType: true,
        vehiclePlate: true,
        vehicleColor: true,
        vehiclePhotoUrl: true,
        profilePhotoUrl: true,
        isAvailable: true,
        profileComplete: true,
        currentLatitude: true,
        currentLongitude: true,
        business: {
          select: {
            id: true,
            name: true,
            latitude: true,
            longitude: true,
            salonProfile: true,
            posVertical: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    const salonProfile = resolveSalonProfile(user.business?.salonProfile);
    const salonLabels = getSalonLabels(salonProfile);

    return {
      ...user,
      salonProfile,
      salonLabels,
      business: user.business
        ? {
            ...user.business,
            salonProfile,
            salonLabels,
          }
        : null,
    };
  }

  private parseDurationToSeconds(duration?: string | null): number {
    if (!duration) return 86400;
    if (/^\d+$/.test(duration)) return parseInt(duration, 10);
    const match = duration.match(/^(\d+)([smhd])$/);
    if (!match) return 86400;
    const val = parseInt(match[1], 10);
    const unit = match[2];
    if (unit === 's') return val;
    if (unit === 'm') return val * 60;
    if (unit === 'h') return val * 3600;
    if (unit === 'd') return val * 86400;
    return 86400;
  }

  private generateTokens(payload: JwtPayload, maxExpiresAt?: Date | null): { accessToken: string; refreshToken: string } {
    let accessExpiresIn: number | string | undefined = undefined;
    let refreshExpiresIn: number | string | undefined = this.configService.get<string>('JWT_REFRESH_EXPIRATION');

    if (maxExpiresAt) {
      const nowMs = Date.now();
      const remainingSec = Math.max(1, Math.floor((maxExpiresAt.getTime() - nowMs) / 1000));

      const defaultAccessExp = this.configService.get<string>('JWT_EXPIRATION') || '1d';
      const defaultAccessSec = this.parseDurationToSeconds(defaultAccessExp);
      accessExpiresIn = Math.min(defaultAccessSec, remainingSec);

      const defaultRefreshExp = this.configService.get<string>('JWT_REFRESH_EXPIRATION') || '7d';
      const defaultRefreshSec = this.parseDurationToSeconds(defaultRefreshExp);
      refreshExpiresIn = Math.min(defaultRefreshSec, remainingSec);
    }

    const accessToken = this.jwtService.sign(payload, accessExpiresIn ? { expiresIn: accessExpiresIn } : undefined);

    const refreshToken = this.jwtService.sign(payload, {
      secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: refreshExpiresIn,
    });

    return { accessToken, refreshToken };
  }
}

