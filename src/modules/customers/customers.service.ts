import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { UpdateCustomerLocationDto } from './dto/update-customer-location.dto';
import {
  CustomerLocationConfirmationLinkDto,
  CustomerLocationSessionPublicDto,
  CustomerResponseDto,
  CustomerSearchResultDto,
} from './dto/customer-response.dto';
import { UserRole } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly trackingGateway: TrackingGateway,
    private readonly configService: ConfigService,
  ) {}

  private isRecent(
    lastConfirmedAt: Date | null,
    maxDays: number = 30,
    hasCoords: boolean = true,
  ): boolean {
    if (!lastConfirmedAt || !hasCoords) return false;
    const maxAgeMs = maxDays * 24 * 60 * 60 * 1000;
    return Date.now() - new Date(lastConfirmedAt).getTime() <= maxAgeMs;
  }

  async search(
    businessId: string,
    query: string,
  ): Promise<CustomerSearchResultDto[]> {
    const trimmed = (query || '').trim();
    if (!trimmed) {
      return [];
    }

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { customerLocationMaxDays: true },
    });
    const maxDays = business?.customerLocationMaxDays ?? 30;

    const customers = await this.prisma.customer.findMany({
      where: {
        businessId,
        OR: [
          { name: { contains: trimmed, mode: 'insensitive' } },
          { phone: { contains: trimmed, mode: 'insensitive' } },
        ],
      },
      take: 10,
      orderBy: [{ lastConfirmedAt: 'desc' }, { updatedAt: 'desc' }],
    });

    return customers.map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      lastLatitude: c.lastLatitude,
      lastLongitude: c.lastLongitude,
      lastAddressText: c.lastAddressText,
      lastConfirmedAt: c.lastConfirmedAt,
      isLocationRecent: this.isRecent(
        c.lastConfirmedAt,
        maxDays,
        c.lastLatitude != null && c.lastLongitude != null,
      ),
    }));
  }

  async lookup(businessId: string, phone: string): Promise<CustomerResponseDto> {
    const trimmed = (phone || '').trim();
    if (!trimmed) {
      throw new BadRequestException('El número de teléfono es requerido');
    }

    const customer = await this.prisma.customer.findUnique({
      where: {
        businessId_phone: {
          businessId,
          phone: trimmed,
        },
      },
    });

    if (!customer) {
      throw new NotFoundException('Cliente no encontrado');
    }

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { customerLocationMaxDays: true },
    });
    const maxDays = business?.customerLocationMaxDays ?? 30;

    return {
      id: customer.id,
      businessId: customer.businessId,
      name: customer.name,
      phone: customer.phone,
      lastLatitude: customer.lastLatitude,
      lastLongitude: customer.lastLongitude,
      lastAddressText: customer.lastAddressText,
      lastConfirmedAt: customer.lastConfirmedAt,
      isLocationRecent: this.isRecent(
        customer.lastConfirmedAt,
        maxDays,
        customer.lastLatitude != null && customer.lastLongitude != null,
      ),
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
    };
  }

  async createLocationConfirmationLinkByData(
    dto: { businessId?: string; phone: string; name: string },
    userBusinessId: string | null,
    userRole: UserRole,
  ): Promise<CustomerLocationConfirmationLinkDto> {
    const businessId = dto.businessId || userBusinessId;
    if (!businessId) {
      throw new BadRequestException('businessId es requerido');
    }

    if (userRole !== UserRole.SUPERADMIN && businessId !== userBusinessId) {
      throw new ForbiddenException('Sin acceso a este negocio');
    }

    const phone = (dto.phone || '').trim();
    const name = (dto.name || '').trim();

    if (!phone) {
      throw new BadRequestException('El número de teléfono es requerido');
    }
    if (!name) {
      throw new BadRequestException('El nombre del cliente es requerido');
    }

    // Upsert automático del Customer por (businessId, phone)
    const customer = await this.prisma.customer.upsert({
      where: {
        businessId_phone: {
          businessId,
          phone,
        },
      },
      update: {
        name,
      },
      create: {
        businessId,
        phone,
        name,
      },
    });

    const token = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 horas

    await this.prisma.customerLocationSession.create({
      data: {
        customerId: customer.id,
        token,
        expiresAt,
      },
    });

    const trackingBaseUrl =
      this.configService.get<string>('TRACKING_URL') ||
      'https://trackdeli-web-tracking.vercel.app';
    const url = `${trackingBaseUrl}/confirm-location/${token}`;

    this.logger.log(
      `[Customers] Link de confirmación generado por datos: customerId=${customer.id}, phone=${phone}, token=${token}`,
    );

    return {
      customerId: customer.id,
      token,
      url,
      confirmationUrl: url,
      expiresAt,
    };
  }

  async createLocationConfirmationLink(
    customerId: string,
    userBusinessId: string | null,
    userRole: UserRole,
  ): Promise<CustomerLocationConfirmationLinkDto> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
    });

    if (!customer) {
      throw new NotFoundException('Cliente no encontrado');
    }

    if (userRole !== UserRole.SUPERADMIN && customer.businessId !== userBusinessId) {
      throw new ForbiddenException('Sin acceso a este cliente');
    }

    const token = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 horas

    await this.prisma.customerLocationSession.create({
      data: {
        customerId,
        token,
        expiresAt,
      },
    });

    const trackingBaseUrl =
      this.configService.get<string>('TRACKING_URL') ||
      'https://trackdeli-web-tracking.vercel.app';
    const url = `${trackingBaseUrl}/confirm-location/${token}`;

    this.logger.log(
      `[Customers] Link de confirmación generado: customerId=${customerId}, token=${token}`,
    );

    return {
      customerId: customer.id,
      token,
      url,
      confirmationUrl: url,
      expiresAt,
    };
  }

  async getLocationSession(token: string): Promise<CustomerLocationSessionPublicDto> {
    const session = await this.prisma.customerLocationSession.findUnique({
      where: { token },
      include: {
        customer: {
          include: {
            business: {
              select: { id: true, name: true, logoUrl: true },
            },
          },
        },
      },
    });

    if (!session || !session.isActive) {
      throw new NotFoundException('Link de confirmación no válido');
    }

    const isExpired = session.expiresAt < new Date();
    if (isExpired) {
      throw new NotFoundException('El link de confirmación ha expirado');
    }

    return {
      valid: true,
      expired: false,
      customerId: session.customer.id,
      name: session.customer.name,
      phone: session.customer.phone,
      lastLatitude: session.customer.lastLatitude,
      lastLongitude: session.customer.lastLongitude,
      lastAddressText: session.customer.lastAddressText,
      lastConfirmedAt: session.customer.lastConfirmedAt,
      customer: {
        id: session.customer.id,
        name: session.customer.name,
        phone: session.customer.phone,
        lastLatitude: session.customer.lastLatitude,
        lastLongitude: session.customer.lastLongitude,
        lastAddressText: session.customer.lastAddressText,
        lastConfirmedAt: session.customer.lastConfirmedAt,
      },
      business: {
        id: session.customer.business.id,
        name: session.customer.business.name,
        logoUrl: session.customer.business.logoUrl,
      },
    };
  }

  async updateLocation(
    customerId: string,
    dto: UpdateCustomerLocationDto,
    tokenParam?: string,
    userRole?: UserRole,
    userBusinessId?: string | null,
  ): Promise<CustomerResponseDto> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
    });

    if (!customer) {
      throw new NotFoundException('Cliente no encontrado');
    }

    // Validación de seguridad / autenticación:
    // Si viene de un usuario autenticado (encargado/superadmin) con acceso a ese negocio
    const isAuthUser =
      userRole &&
      (userRole === UserRole.SUPERADMIN || customer.businessId === userBusinessId);

    if (!isAuthUser) {
      // Validar por token temporal
      const token = dto.token || tokenParam;
      if (!token) {
        throw new ForbiddenException('Token de confirmación requerido');
      }

      const session = await this.prisma.customerLocationSession.findFirst({
        where: {
          customerId,
          token,
          isActive: true,
          expiresAt: { gt: new Date() },
        },
      });

      if (!session) {
        throw new ForbiddenException(
          'Token de confirmación no válido o expirado',
        );
      }
    }

    const now = new Date();
    const isSameLocation = dto.confirmedSameLocation === true;
    const updateData: any = {
      lastConfirmedAt: now,
    };

    if (!isSameLocation) {
      if (dto.latitude != null) updateData.lastLatitude = Number(dto.latitude);
      if (dto.longitude != null) updateData.lastLongitude = Number(dto.longitude);
      if (dto.addressText !== undefined) updateData.lastAddressText = dto.addressText;
    }

    const updated = await this.prisma.customer.update({
      where: { id: customerId },
      data: updateData,
    });

    // Emisión por WebSocket a la sala business:${businessId}
    if (isSameLocation) {
      this.trackingGateway.notifyBusiness(
        customer.businessId,
        'customer_location_confirmed',
        {
          customerId: customer.id,
          phone: customer.phone,
          name: customer.name,
          latitude: updated.lastLatitude,
          longitude: updated.lastLongitude,
          addressText: updated.lastAddressText,
          confirmedAt: now.toISOString(),
        },
      );
      this.logger.log(
        `[Customers] Socket 'customer_location_confirmed' emitido a business:${customer.businessId} (customerId=${customer.id})`,
      );
    } else {
      this.trackingGateway.notifyBusiness(
        customer.businessId,
        'customer_location_updated',
        {
          customerId: customer.id,
          phone: customer.phone,
          name: customer.name,
          latitude: updated.lastLatitude,
          longitude: updated.lastLongitude,
          addressText: updated.lastAddressText,
          confirmedAt: now.toISOString(),
        },
      );
      this.logger.log(
        `[Customers] Socket 'customer_location_updated' emitido a business:${customer.businessId} (customerId=${customer.id}, lat=${updated.lastLatitude}, lng=${updated.lastLongitude})`,
      );
    }

    return {
      id: updated.id,
      businessId: updated.businessId,
      name: updated.name,
      phone: updated.phone,
      lastLatitude: updated.lastLatitude,
      lastLongitude: updated.lastLongitude,
      lastAddressText: updated.lastAddressText,
      lastConfirmedAt: updated.lastConfirmedAt,
      isLocationRecent: true,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  async upsertFromOrder(params: {
    businessId: string;
    phone: string;
    name: string;
    destinationLat?: number | null;
    destinationLng?: number | null;
    destinationAddress?: string | null;
  }) {
    const phone = (params.phone || '').trim();
    if (!phone || !params.businessId) return null;

    const hasCoords =
      params.destinationLat != null && params.destinationLng != null;
    const now = new Date();

    try {
      return await this.prisma.customer.upsert({
        where: {
          businessId_phone: {
            businessId: params.businessId,
            phone,
          },
        },
        update: {
          name: params.name,
          ...(hasCoords ? { lastLatitude: Number(params.destinationLat) } : {}),
          ...(hasCoords ? { lastLongitude: Number(params.destinationLng) } : {}),
          ...(params.destinationAddress
            ? { lastAddressText: params.destinationAddress }
            : {}),
          ...(hasCoords ? { lastConfirmedAt: now } : {}),
        },
        create: {
          businessId: params.businessId,
          phone,
          name: params.name,
          lastLatitude: hasCoords ? Number(params.destinationLat) : null,
          lastLongitude: hasCoords ? Number(params.destinationLng) : null,
          lastAddressText: params.destinationAddress || null,
          lastConfirmedAt: hasCoords ? now : null,
        },
      });
    } catch (err: any) {
      this.logger.warn(
        `[Customers] Error al hacer upsert de cliente recurrente: ${err.message}`,
      );
      return null;
    }
  }
}
