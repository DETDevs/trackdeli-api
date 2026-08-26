import { Injectable, UnauthorizedException, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { LoginDto } from './dto/login.dto';
import { TokenResponseDto } from './dto/token-response.dto';
import { RegisterRiderDto } from './dto/register-rider.dto';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { User } from '@prisma/client';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async validateUser(email: string, password: string): Promise<User | null> {
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      return null;
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
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
      this.logger.warn(`[Auth] Login fallido: email=${dto.email}, razón=credenciales inválidas`);
      throw new UnauthorizedException('Credenciales inválidas');
    }

    this.logger.log(`[Auth] Login exitoso: email=${dto.email}, rol=${user.role}, negocio=${user.businessId}`);

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
      },
    };
  }

  async registerRider(dto: RegisterRiderDto): Promise<TokenResponseDto> {
    try {
      const passwordHash = await bcrypt.hash(dto.password, 10);
      
      const user = await this.prisma.user.create({
        data: {
          email: dto.email,
          passwordHash,
          name: dto.name,
          phone: dto.phone,
          role: 'REPARTIDOR',
          businessId: null,
          isAvailable: true,
          vehicleType: dto.vehicleType,
          vehiclePlate: dto.vehiclePlate,
          vehicleColor: dto.vehicleColor,
        },
      });

      this.logger.log(`[Auth] Nuevo repartidor registrado: email=${dto.email}`);

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
        },
      };
    } catch (error) {
      if (error.code === 'P2002') {
        throw new ConflictException('El correo electrónico ya está en uso');
      }
      throw error;
    }
  }

  async refresh(userId: string, refreshToken: string): Promise<TokenResponseDto> {
    try {
      const decoded = this.jwtService.verify(refreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });

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
      };

      const tokens = this.generateTokens(payload);
      
      this.logger.log(`[Auth] Token refrescado: userId=${user.id}`);
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
        },
      };
    } catch (error) {
      this.logger.warn(`[Auth] Refresh fallido: userId=${userId}`);
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

