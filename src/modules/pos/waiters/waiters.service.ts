import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BusinessProductsService } from '../../business-products/business-products.service';
import { BusinessProductType, UserRole } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { WaiterLoginDto } from './dto/waiter-login.dto';
import { CreateWaiterDto } from './dto/create-waiter.dto';
import { UpdateWaiterDto } from './dto/update-waiter.dto';

@Injectable()
export class WaitersService {
  private readonly logger = new Logger(WaitersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly businessProductsService: BusinessProductsService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Resuelve el negocio por ID o por Slug, validando que esté activo y cuente con POS.
   */
  async resolveBusiness(businessIdOrSlug: string) {
    if (!businessIdOrSlug) {
      throw new BadRequestException('Identificador de negocio no proporcionado');
    }

    const trimmed = businessIdOrSlug.trim();

    let business = await this.prisma.business.findUnique({
      where: { id: trimmed },
    });

    if (!business) {
      business = await this.prisma.business.findUnique({
        where: { slug: trimmed.toLowerCase() },
      });
    }

    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }

    if (!business.isActive) {
      throw new ForbiddenException('Negocio inactivo');
    }

    const isPosActive = await this.businessProductsService.isActive(
      business.id,
      BusinessProductType.POS,
    );

    if (!isPosActive) {
      throw new ForbiddenException(
        'El módulo POS no está activo para este negocio.',
      );
    }

    return business;
  }

  /**
   * Lista pública de meseros activos para el selector de nombres.
   * Devuelve únicamente id y name (sin pinHash ni datos sensibles).
   */
  async getPublicWaiters(slugOrId: string) {
    const business = await this.resolveBusiness(slugOrId);

    const waiters = await this.prisma.waiter.findMany({
      where: {
        businessId: business.id,
        active: true,
      },
      select: {
        id: true,
        name: true,
      },
      orderBy: {
        name: 'asc',
      },
    });

    return waiters;
  }

  /**
   * Autenticación de mesero mediante PIN de 4 dígitos.
   * Genera un JWT scoped con rol WAITER.
   */
  async loginWithPin(slugOrId: string, dto: WaiterLoginDto) {
    const business = await this.resolveBusiness(slugOrId);

    let waiter: {
      id: string;
      name: string;
      businessId: string;
      pinHash: string;
      active: boolean;
    } | null = null;

    if (dto.waiterId) {
      waiter = await this.prisma.waiter.findFirst({
        where: {
          id: dto.waiterId,
          businessId: business.id,
        },
      });
    } else if (dto.name) {
      waiter = await this.prisma.waiter.findFirst({
        where: {
          businessId: business.id,
          name: { equals: dto.name.trim(), mode: 'insensitive' },
        },
      });
    } else {
      throw new BadRequestException('Debe seleccionar o indicar un mesero para iniciar sesión');
    }

    if (!waiter || !waiter.active) {
      throw new UnauthorizedException('Mesero no encontrado o inactivo');
    }

    const isPinValid = await bcrypt.compare(dto.pin, waiter.pinHash);
    if (!isPinValid) {
      throw new UnauthorizedException('PIN incorrecto');
    }

    const payload: JwtPayload = {
      sub: waiter.id,
      email: `${waiter.id}@waiter.trackdeli.com`,
      role: UserRole.WAITER,
      businessId: waiter.businessId,
      waiterName: waiter.name,
      profileComplete: true,
    };

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: '30d',
    });

    const refreshSecret =
      this.configService.get<string>('JWT_REFRESH_SECRET') ||
      this.configService.get<string>('JWT_SECRET');

    const refreshToken = this.jwtService.sign(payload, {
      secret: refreshSecret,
      expiresIn: '60d',
    });

    this.logger.log(`[loginWithPin] Mesero autenticado: id=${waiter.id} name="${waiter.name}" businessId=${business.id}`);

    return {
      accessToken,
      refreshToken,
      waiter: {
        id: waiter.id,
        name: waiter.name,
        businessId: waiter.businessId,
        role: UserRole.WAITER,
      },
    };
  }

  /**
   * Administración de meseros (ENCARGADO / SUPERADMIN)
   */
  async findAll(businessId: string) {
    return this.prisma.waiter.findMany({
      where: { businessId },
      select: {
        id: true,
        businessId: true,
        name: true,
        active: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(businessId: string, id: string) {
    const waiter = await this.prisma.waiter.findFirst({
      where: { id, businessId },
      select: {
        id: true,
        businessId: true,
        name: true,
        active: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!waiter) {
      throw new NotFoundException('Mesero no encontrado');
    }

    return waiter;
  }

  async create(businessId: string, dto: CreateWaiterDto) {
    const existing = await this.prisma.waiter.findFirst({
      where: {
        businessId,
        name: { equals: dto.name.trim(), mode: 'insensitive' },
      },
    });

    if (existing) {
      throw new ConflictException(`Ya existe un mesero con el nombre "${dto.name.trim()}" en este negocio`);
    }

    const pinHash = await bcrypt.hash(dto.pin, 10);

    const waiter = await this.prisma.waiter.create({
      data: {
        businessId,
        name: dto.name.trim(),
        pinHash,
        active: dto.active !== undefined ? dto.active : true,
      },
      select: {
        id: true,
        businessId: true,
        name: true,
        active: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    this.logger.log(`[create] Mesero creado: id=${waiter.id} name="${waiter.name}" businessId=${businessId}`);
    return waiter;
  }

  async update(businessId: string, id: string, dto: UpdateWaiterDto) {
    const waiter = await this.prisma.waiter.findFirst({
      where: { id, businessId },
    });

    if (!waiter) {
      throw new NotFoundException('Mesero no encontrado');
    }

    if (dto.name && dto.name.trim().toLowerCase() !== waiter.name.toLowerCase()) {
      const existing = await this.prisma.waiter.findFirst({
        where: {
          businessId,
          name: { equals: dto.name.trim(), mode: 'insensitive' },
          id: { not: id },
        },
      });

      if (existing) {
        throw new ConflictException(`Ya existe un mesero con el nombre "${dto.name.trim()}"`);
      }
    }

    let pinHash: string | undefined;
    if (dto.pin) {
      pinHash = await bcrypt.hash(dto.pin, 10);
    }

    const updated = await this.prisma.waiter.update({
      where: { id },
      data: {
        ...(dto.name && { name: dto.name.trim() }),
        ...(pinHash && { pinHash }),
        ...(dto.active !== undefined && { active: dto.active }),
      },
      select: {
        id: true,
        businessId: true,
        name: true,
        active: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    this.logger.log(`[update] Mesero actualizado: id=${id} active=${updated.active}`);
    return updated;
  }

  async remove(businessId: string, id: string) {
    const waiter = await this.prisma.waiter.findFirst({
      where: { id, businessId },
    });

    if (!waiter) {
      throw new NotFoundException('Mesero no encontrado');
    }

    await this.prisma.waiter.update({
      where: { id },
      data: { active: false },
    });

    this.logger.log(`[remove] Mesero desactivado: id=${id}`);
    return { success: true, message: 'Mesero desactivado exitosamente' };
  }
}
