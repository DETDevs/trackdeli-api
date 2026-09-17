import { Injectable, UnauthorizedException, Logger, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { LoginDto } from './dto/login.dto';
import { TokenResponseDto } from './dto/token-response.dto';
import { RegisterRiderDto } from './dto/register-rider.dto';
import { SocialLoginDto } from './dto/social-login.dto';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { User, AuthProvider } from '@prisma/client';
import { FirebaseService } from '../notifications/firebase.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private firebaseService: FirebaseService,
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

  async login(dto: LoginDto): Promise<TokenResponseDto> {
    const user = await this.validateUser(dto.email, dto.password);

    if (!user) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

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
      };
    } catch (error) {
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
            name: true,
            latitude: true,
            longitude: true,
          }
        }
      }
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    return user;
  }

  private generateTokens(payload: JwtPayload): { accessToken: string; refreshToken: string } {
    const accessToken = this.jwtService.sign(payload);

    const refreshToken = this.jwtService.sign(payload, {
      secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: this.configService.get<string>('JWT_REFRESH_EXPIRATION'),
    });

    return { accessToken, refreshToken };
  }
}

