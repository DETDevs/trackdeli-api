import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { UpdateCustomerLocationDto } from './dto/update-customer-location.dto';
import { CreateCustomerDto } from './dto/create-customer.dto';
import {
  CustomerLocationConfirmationLinkDto,
  CustomerLocationSessionPublicDto,
  CustomerResponseDto,
  CustomerSearchResultDto,
} from './dto/customer-response.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { BusinessProductType, CreditAccountStatus, NotificationChannel, NotificationLogStatus, Prisma, UserRole } from '@prisma/client';
import { BusinessProductsService } from '../business-products/business-products.service';
import { NotificationsService } from '../notifications/notifications.service';
import { generateShortCode, normalizeShortCode } from '../../common/utils/short-code.util';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly trackingGateway: TrackingGateway,
    private readonly configService: ConfigService,
    private readonly businessProductsService: BusinessProductsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private async generateUniqueShortCode(): Promise<string> {
    const maxAttempts = 5;
    for (let i = 0; i < maxAttempts; i++) {
      const candidate = generateShortCode();
      const existing = await this.prisma.customerLocationSession.findFirst({
        where: {
          OR: [
            { shortCode: candidate },
            { token: candidate },
          ],
        },
        select: { id: true },
      });
      if (!existing) {
        return candidate;
      }
    }
    return generateShortCode(10);
  }

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
    groupId?: string,
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

    const where: Prisma.CustomerWhereInput = {
      businessId,
      ...(groupId && groupId.trim() ? { groupId: groupId.trim() } : {}),
      OR: [
        { name: { contains: trimmed, mode: 'insensitive' } },
        { phone: { contains: trimmed, mode: 'insensitive' } },
        { externalCode: { contains: trimmed, mode: 'insensitive' } },
        { ruc: { contains: trimmed, mode: 'insensitive' } },
      ],
    };

    const customers = await this.prisma.customer.findMany({
      where,
      take: 10,
      orderBy: [{ lastConfirmedAt: 'desc' }, { updatedAt: 'desc' }],
    });

    return customers.map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      ruc: c.ruc ?? null,
      creditLimit: c.creditLimit ?? null,
      groupId: c.groupId ?? null,
      externalCode: c.externalCode ?? null,
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
      ruc: customer.ruc ?? null,
      creditLimit: customer.creditLimit ?? null,
      groupId: customer.groupId ?? null,
      externalCode: customer.externalCode ?? null,
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

  async create(
    businessId: string,
    dto: CreateCustomerDto,
  ): Promise<CustomerResponseDto> {
    const name = (dto.name || '').trim();
    const phone = (dto.phone || '').trim();

    if (!name) {
      throw new BadRequestException('El nombre del cliente es requerido');
    }
    if (!phone) {
      throw new BadRequestException('El número de teléfono es requerido');
    }

    const existing = await this.prisma.customer.findUnique({
      where: {
        businessId_phone: {
          businessId,
          phone,
        },
      },
    });

    if (existing) {
      throw new ConflictException(
        `Ya existe un cliente registrado con el teléfono ${phone} (${existing.name})`,
      );
    }

    if (dto.externalCode && dto.externalCode.trim()) {
      const existingCode = await this.prisma.customer.findFirst({
        where: {
          businessId,
          externalCode: dto.externalCode.trim(),
        },
      });
      if (existingCode) {
        throw new ConflictException(
          `Ya existe un cliente con el código ${dto.externalCode.trim()} (${existingCode.name})`,
        );
      }
    }

    if (dto.groupId) {
      const group = await this.prisma.creditGroup.findFirst({
        where: { id: dto.groupId, businessId },
      });
      if (!group) {
        throw new BadRequestException('La empresa/convenio especificada no existe');
      }
    }

    const customer = await this.prisma.customer.create({
      data: {
        businessId,
        name,
        phone,
        email: dto.email?.trim() || null,
        notes: dto.notes?.trim() || null,
        ruc: dto.ruc?.trim() || null,
        creditLimit: dto.creditLimit !== undefined ? dto.creditLimit : null,
        groupId: dto.groupId || null,
        externalCode: dto.externalCode?.trim() || null,
        lastAddressText: dto.address?.trim() || null,
      },
      include: {
        group: {
          select: { id: true, name: true, taxId: true },
        },
      },
    });

    return {
      id: customer.id,
      businessId: customer.businessId,
      name: customer.name,
      phone: customer.phone,
      ruc: customer.ruc ?? null,
      creditLimit: customer.creditLimit ?? null,
      groupId: customer.groupId ?? null,
      group: customer.group ?? null,
      externalCode: customer.externalCode ?? null,
      lastLatitude: customer.lastLatitude,
      lastLongitude: customer.lastLongitude,
      lastAddressText: customer.lastAddressText,
      lastConfirmedAt: customer.lastConfirmedAt,
      isLocationRecent: false,
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
    };
  }

  async createLocationConfirmationLinkByData(
    dto: { businessId?: string; phone: string; name: string; orderId?: string },
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

    const shortCode = await this.generateUniqueShortCode();
    const token = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

    await this.prisma.customerLocationSession.create({
      data: {
        customerId: customer.id,
        token,
        shortCode,
        expiresAt,
      },
    });

    const trackingBaseUrl = this.configService
      .getOrThrow<string>('TRACKING_URL')
      .replace(/\/+$/, '');
    const url = `${trackingBaseUrl}/c/${shortCode}`;

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { name: true },
    });
    const businessName = business?.name || 'TrackDeli';

    const clientName = customer.name.trim();
    const greeting = clientName ? `¡Hola ${clientName}!` : '¡Hola!';
    const message =
      `${greeting} Para coordinar la entrega de tu pedido con ${businessName}, ` +
      `por favor confirmá tu ubicación exacta en este enlace:\n\n` +
      `${url}\n\n` +
      `📍 TrackDeli`;

    const cleanDigits = phone.replace(/\D/g, '');
    const fullPhone = cleanDigits.length === 8 ? `505${cleanDigits}` : cleanDigits;
    const whatsappUrl = cleanDigits
      ? `https://wa.me/${fullPhone}?text=${encodeURIComponent(message)}`
      : '';

    let autoSent = false;
    // Envío automático vía WhatsAppChannel (awaitDirect para retornar autoSent sin fallar la creación del link)
    if (cleanDigits) {
      try {
        const notif = await this.notificationsService.dispatchNotification({
          businessId,
          channel: NotificationChannel.WHATSAPP,
          event: 'LOCATION_CONFIRMATION_REQUEST',
          recipientContact: fullPhone,
          variables: {
            customerName: customer.name,
            businessName,
            orderSummary: dto.orderId ? 'tu pedido' : businessName,
            shortCode,
            confirmationUrl: url,
            url,
          },
          relatedEntityType: dto.orderId ? 'Order' : 'Customer',
          relatedEntityId: dto.orderId ? dto.orderId : customer.id,
          awaitDirect: true,
        });
        autoSent = notif.status === NotificationLogStatus.SENT;
      } catch (err: any) {
        this.logger.warn(
          `[Customers] Error enviando WhatsApp de confirmación de ubicación: ${err.message}`,
        );
      }
    }

    this.logger.log(
      `[Customers] Link de confirmación generado por datos: customerId=${customer.id}, phone=${phone}, shortCode=${shortCode}, autoSent=${autoSent}`,
    );

    return {
      customerId: customer.id,
      token: shortCode,
      shortCode,
      url,
      confirmationUrl: url,
      whatsappUrl,
      expiresAt,
      autoSent,
    };
  }

  async createLocationConfirmationLink(
    customerId: string,
    userBusinessId: string | null,
    userRole: UserRole,
    orderId?: string,
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

    const shortCode = await this.generateUniqueShortCode();
    const token = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

    await this.prisma.customerLocationSession.create({
      data: {
        customerId,
        token,
        shortCode,
        expiresAt,
      },
    });

    const trackingBaseUrl = this.configService
      .getOrThrow<string>('TRACKING_URL')
      .replace(/\/+$/, '');
    const url = `${trackingBaseUrl}/c/${shortCode}`;

    const business = await this.prisma.business.findUnique({
      where: { id: customer.businessId },
      select: { name: true },
    });
    const businessName = business?.name || 'TrackDeli';

    const clientName = customer.name.trim();
    const greeting = clientName ? `¡Hola ${clientName}!` : '¡Hola!';
    const message =
      `${greeting} Para coordinar la entrega de tu pedido con ${businessName}, ` +
      `por favor confirmá tu ubicación exacta en este enlace:\n\n` +
      `${url}\n\n` +
      `📍 TrackDeli`;

    const cleanDigits = (customer.phone || '').replace(/\D/g, '');
    const fullPhone = cleanDigits.length === 8 ? `505${cleanDigits}` : cleanDigits;
    const whatsappUrl = cleanDigits
      ? `https://wa.me/${fullPhone}?text=${encodeURIComponent(message)}`
      : '';

    let autoSent = false;
    // Envío automático vía WhatsAppChannel (awaitDirect para retornar autoSent sin fallar la creación del link)
    if (cleanDigits) {
      try {
        const notif = await this.notificationsService.dispatchNotification({
          businessId: customer.businessId,
          channel: NotificationChannel.WHATSAPP,
          event: 'LOCATION_CONFIRMATION_REQUEST',
          recipientContact: fullPhone,
          variables: {
            customerName: customer.name,
            businessName,
            orderSummary: orderId ? 'tu pedido' : businessName,
            shortCode,
            confirmationUrl: url,
            url,
          },
          relatedEntityType: orderId ? 'Order' : 'Customer',
          relatedEntityId: orderId ? orderId : customer.id,
          awaitDirect: true,
        });
        autoSent = notif.status === NotificationLogStatus.SENT;
      } catch (err: any) {
        this.logger.warn(
          `[Customers] Error enviando WhatsApp de confirmación de ubicación: ${err.message}`,
        );
      }
    }

    this.logger.log(
      `[Customers] Link de confirmación generado: customerId=${customerId}, shortCode=${shortCode}, autoSent=${autoSent}`,
    );

    return {
      customerId: customer.id,
      token: shortCode,
      shortCode,
      url,
      confirmationUrl: url,
      whatsappUrl,
      expiresAt,
      autoSent,
    };
  }

  async getLocationSession(tokenOrCode: string): Promise<CustomerLocationSessionPublicDto> {
    const raw = (tokenOrCode || '').trim();
    const normalized = normalizeShortCode(raw);

    const session = await this.prisma.customerLocationSession.findFirst({
      where: {
        OR: [
          { shortCode: raw },
          { shortCode: normalized },
          { token: raw },
        ],
      },
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
    const sessionStatus = ((session as any).status || 'PENDING') as 'PENDING' | 'RESPONDED';

    return {
      valid: true,
      expired: isExpired,
      sessionStatus,
      status: sessionStatus,
      respondedAt: (session as any).respondedAt ?? null,
      token: session.shortCode || session.token,
      shortCode: session.shortCode ?? undefined,
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

    const isAuthUser =
      userRole &&
      (userRole === UserRole.SUPERADMIN || customer.businessId === userBusinessId);

    const token = (dto.token || tokenParam || '').trim();
    const normalizedToken = normalizeShortCode(token);

    if (!isAuthUser) {
      if (!token) {
        throw new ForbiddenException('Token de confirmación requerido');
      }

      const session = await this.prisma.customerLocationSession.findFirst({
        where: {
          customerId,
          OR: [
            { shortCode: token },
            { shortCode: normalizedToken },
            { token },
          ],
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

    const updated = await this.prisma.$transaction(async (tx) => {
      const cust = await tx.customer.update({
        where: { id: customerId },
        data: updateData,
      });

      if (token) {
        await tx.customerLocationSession.updateMany({
          where: {
            customerId,
            OR: [
              { shortCode: token },
              { shortCode: normalizedToken },
              { token },
            ],
          },
          data: {
            status: 'RESPONDED',
            respondedAt: now,
          },
        });
      }

      return cust;
    });

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

  async findAll(
    businessId: string,
    options: {
      search?: string;
      q?: string;
      groupId?: string;
      page?: number | string;
      limit?: number | string;
      onlyWithBalance?: boolean | string;
    } = {},
  ) {
    // 1. Validar límite (default 50, máx 100)
    let limit = 50;
    if (options.limit !== undefined && options.limit !== null && options.limit !== '') {
      const numLimit = Number(options.limit);
      if (isNaN(numLimit) || numLimit < 1) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'INVALID_LIMIT',
          message: 'El parámetro "limit" debe ser un número entero mayor a 0',
        });
      }
      if (numLimit > 100) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'INVALID_LIMIT',
          message: 'El parámetro "limit" no puede ser mayor a 100 (máximo permitido: 100)',
        });
      }
      limit = Math.floor(numLimit);
    }

    // 2. Validar página
    let page = 1;
    if (options.page !== undefined && options.page !== null && options.page !== '') {
      const numPage = Number(options.page);
      if (isNaN(numPage) || numPage < 1) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'INVALID_PAGE',
          message: 'El parámetro "page" debe ser un número entero mayor a 0',
        });
      }
      page = Math.floor(numPage);
    }

    const skip = (page - 1) * limit;

    // 3. Término de búsqueda (search oficial, q retrocompatible)
    const searchTerm = (options.search ?? options.q ?? '').trim();

    // 4. Construcción del filtro where
    const where: Prisma.CustomerWhereInput = {
      businessId,
    };

    // Filtro por groupId si viene especificado
    if (options.groupId && options.groupId.trim()) {
      const targetGroupId = options.groupId.trim();
      const group = await this.prisma.creditGroup.findFirst({
        where: { id: targetGroupId, businessId },
      });
      if (!group) {
        throw new NotFoundException({
          statusCode: 404,
          error: 'Not Found',
          code: 'GROUP_NOT_FOUND',
          message: 'Empresa o grupo de crédito no encontrado',
        });
      }
      where.groupId = targetGroupId;
    }

    // Filtro de búsqueda textual
    if (searchTerm) {
      where.OR = [
        { name: { contains: searchTerm, mode: 'insensitive' } },
        { phone: { contains: searchTerm, mode: 'insensitive' } },
        { email: { contains: searchTerm, mode: 'insensitive' } },
        { ruc: { contains: searchTerm, mode: 'insensitive' } },
        { externalCode: { contains: searchTerm, mode: 'insensitive' } },
      ];
    }

    // Filtro por saldo pendiente (onlyWithBalance)
    const isOnlyWithBalance =
      options.onlyWithBalance === true ||
      options.onlyWithBalance === 'true' ||
      options.onlyWithBalance === '1';

    if (isOnlyWithBalance) {
      where.creditAccounts = {
        some: {
          status: {
            in: [
              CreditAccountStatus.PENDING,
              CreditAccountStatus.PARTIALLY_PAID,
              CreditAccountStatus.OVERDUE,
            ],
          },
          balance: { gt: 0 },
        },
      };
    }

    const [customers, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ name: 'asc' }, { createdAt: 'desc' }],
        include: {
          group: {
            select: { id: true, name: true, taxId: true },
          },
          creditAccounts: {
            where: {
              status: {
                in: [
                  CreditAccountStatus.PENDING,
                  CreditAccountStatus.PARTIALLY_PAID,
                  CreditAccountStatus.OVERDUE,
                ],
              },
              balance: { gt: 0 },
            },
            select: {
              balance: true,
            },
          },
          _count: {
            select: {
              appointments: true,
              creditAccounts: true,
              sales: true,
            },
          },
        },
      }),
      this.prisma.customer.count({ where }),
    ]);

    const items = customers.map((c) => {
      const currentBalance = (c.creditAccounts || []).reduce(
        (sum, ca) => sum + (Number(ca.balance) || 0),
        0,
      );
      const roundedBalance = Math.round(currentBalance * 100) / 100;
      return {
        id: c.id,
        businessId: c.businessId,
        name: c.name,
        phone: c.phone,
        email: c.email ?? null,
        notes: c.notes ?? null,
        ruc: c.ruc ?? null,
        creditLimit:
          c.creditLimit !== null && c.creditLimit !== undefined
            ? Number(c.creditLimit)
            : null,
        groupId: c.groupId ?? null,
        externalCode: c.externalCode ?? null,
        group: c.group ?? null,
        isBlocked: c.isBlocked,
        consecutiveNoShows: c.consecutiveNoShows,
        lastAddressText: c.lastAddressText ?? null,
        currentBalance: roundedBalance,
        balance: roundedBalance,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        _count: c._count,
      };
    });

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  private getPhoneVariants(phone: string): string[] {
    const trimmed = (phone || '').trim();
    if (!trimmed) return [];
    const digitsOnly = trimmed.replace(/\D/g, '');
    const variants = new Set<string>();
    variants.add(trimmed);
    if (digitsOnly) {
      variants.add(digitsOnly);
      if (digitsOnly.length === 8) {
        variants.add(`+505${digitsOnly}`);
        variants.add(`505${digitsOnly}`);
      } else if (digitsOnly.length === 11 && digitsOnly.startsWith('505')) {
        variants.add(digitsOnly.slice(3));
        variants.add(`+${digitsOnly}`);
      }
    }
    return Array.from(variants);
  }

  async findById(businessId: string, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, businessId },
      include: {
        _count: {
          select: {
            appointments: true,
            creditAccounts: true,
            sales: true,
          },
        },
      },
    });

    if (!customer) {
      throw new NotFoundException('Cliente no encontrado');
    }

    const phoneVariants = this.getPhoneVariants(customer.phone);

    const [orders, sales, ordersCount] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          businessId,
          customerPhone: { in: phoneVariants },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: {
          deliveryUser: {
            select: { id: true, name: true, phone: true },
          },
          photos: true,
          originBusinessClient: {
            select: { id: true, name: true },
          },
        },
      }),
      this.prisma.sale.findMany({
        where: {
          businessId,
          OR: [
            { customerId: id },
            { customerPhone: { in: phoneVariants } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: {
          items: true,
        },
      }),
      this.prisma.order.count({
        where: {
          businessId,
          customerPhone: { in: phoneVariants },
        },
      }),
    ]);

    return {
      ...customer,
      orders,
      sales,
      _count: {
        ...customer._count,
        orders: ordersCount,
      },
    };
  }

  async getHistory(businessId: string, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, businessId },
    });

    if (!customer) {
      throw new NotFoundException('Cliente no encontrado');
    }

    const [isCitasActive, isCarteraActive] = await Promise.all([
      this.businessProductsService.isActive(
        businessId,
        BusinessProductType.CITAS,
      ),
      this.businessProductsService.isActive(
        businessId,
        BusinessProductType.CARTERA_COBRO,
      ),
    ]);

    const phoneVariants = this.getPhoneVariants(customer.phone);

    const [appointments, creditAccounts, orders, sales, ordersCount] =
      await Promise.all([
        isCitasActive
          ? this.prisma.appointment.findMany({
              where: { customerId: id, businessId },
              include: {
                service: {
                  select: {
                    id: true,
                    name: true,
                    price: true,
                    durationMinutes: true,
                  },
                },
                specialist: {
                  select: {
                    id: true,
                    name: true,
                    specialty: true,
                  },
                },
              },
              orderBy: { scheduledAt: 'desc' },
            })
          : Promise.resolve(null),
        isCarteraActive
          ? this.prisma.creditAccount.findMany({
              where: { customerId: id, businessId },
              include: {
                sale: {
                  select: {
                    id: true,
                    invoiceNumber: true,
                    invoiceDate: true,
                    total: true,
                  },
                },
                payments: {
                  orderBy: { receivedAt: 'desc' },
                  include: {
                    receivedByUser: {
                      select: {
                        id: true,
                        name: true,
                      },
                    },
                  },
                },
              },
              orderBy: { createdAt: 'desc' },
            })
          : Promise.resolve(null),
        this.prisma.order.findMany({
          where: {
            businessId,
            customerPhone: { in: phoneVariants },
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: {
            deliveryUser: {
              select: { id: true, name: true, phone: true },
            },
            photos: true,
            originBusinessClient: {
              select: { id: true, name: true },
            },
          },
        }),
        this.prisma.sale.findMany({
          where: {
            businessId,
            OR: [
              { customerId: id },
              { customerPhone: { in: phoneVariants } },
            ],
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: {
            items: true,
          },
        }),
        this.prisma.order.count({
          where: {
            businessId,
            customerPhone: { in: phoneVariants },
          },
        }),
      ]);

    const mappedAppointments = appointments
      ? appointments.map((app: any) => ({
          ...app,
          service: app.service
            ? {
                ...app.service,
                specialist: app.specialist ?? null,
              }
            : null,
        }))
      : null;

    return {
      customer: {
        id: customer.id,
        businessId: customer.businessId,
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        notes: customer.notes,
        creditLimit: customer.creditLimit,
        ruc: customer.ruc,
        isBlocked: customer.isBlocked,
        consecutiveNoShows: customer.consecutiveNoShows,
        lastLatitude: customer.lastLatitude,
        lastLongitude: customer.lastLongitude,
        lastAddressText: customer.lastAddressText,
        lastConfirmedAt: customer.lastConfirmedAt,
        createdAt: customer.createdAt,
        updatedAt: customer.updatedAt,
      },
      products: {
        citas: isCitasActive,
        carteraCobro: isCarteraActive,
      },
      appointments: mappedAppointments,
      creditAccounts,
      orders,
      sales,
      _count: {
        orders: ordersCount,
        sales: sales.length,
        appointments: mappedAppointments?.length ?? 0,
        creditAccounts: creditAccounts?.length ?? 0,
      },
    };
  }

  async updateCustomer(
    businessId: string,
    id: string,
    dto: UpdateCustomerDto,
  ) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, businessId },
    });

    if (!customer) {
      throw new NotFoundException('Cliente no encontrado');
    }

    if (dto.phone && dto.phone.trim() !== customer.phone) {
      const existing = await this.prisma.customer.findUnique({
        where: {
          businessId_phone: {
            businessId,
            phone: dto.phone.trim(),
          },
        },
      });
      if (existing && existing.id !== id) {
        throw new ConflictException(
          `Ya existe otro cliente con el teléfono ${dto.phone.trim()}`,
        );
      }
    }

    if (dto.externalCode !== undefined) {
      const cleanCode = dto.externalCode?.trim() || null;
      if (cleanCode && cleanCode !== customer.externalCode) {
        const existing = await this.prisma.customer.findFirst({
          where: {
            businessId,
            externalCode: cleanCode,
          },
        });
        if (existing && existing.id !== id) {
          throw new ConflictException(
            `Ya existe otro cliente con el código ${cleanCode} (${existing.name})`,
          );
        }
      }
    }

    if (dto.groupId !== undefined && dto.groupId) {
      const group = await this.prisma.creditGroup.findFirst({
        where: { id: dto.groupId, businessId },
      });
      if (!group) {
        throw new BadRequestException('La empresa/convenio especificada no existe');
      }
    }

    const hasNewCoords = dto.latitude != null && dto.longitude != null;
    const now = new Date();

    return this.prisma.customer.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.phone !== undefined && { phone: dto.phone.trim() }),
        ...(dto.email !== undefined && { email: dto.email?.trim() || null }),
        ...(dto.notes !== undefined && { notes: dto.notes?.trim() || null }),
        ...(dto.ruc !== undefined && { ruc: dto.ruc?.trim() || null }),
        ...(dto.creditLimit !== undefined && {
          creditLimit: dto.creditLimit,
        }),
        ...(dto.groupId !== undefined && { groupId: dto.groupId || null }),
        ...(dto.externalCode !== undefined && { externalCode: dto.externalCode?.trim() || null }),
        ...(dto.address !== undefined && {
          lastAddressText: dto.address?.trim() || null,
        }),
        ...(dto.latitude !== undefined && {
          lastLatitude: dto.latitude != null ? Number(dto.latitude) : null,
        }),
        ...(dto.longitude !== undefined && {
          lastLongitude: dto.longitude != null ? Number(dto.longitude) : null,
        }),
        ...(hasNewCoords && { lastConfirmedAt: now }),
        ...(dto.isBlocked !== undefined && { isBlocked: dto.isBlocked }),
      },
      include: {
        group: {
          select: { id: true, name: true, taxId: true },
        },
      },
    });
  }

  async getByCode(businessId: string, code: string, userRole?: string) {
    const cleanCode = (code || '').trim();
    if (!cleanCode) {
      throw new BadRequestException('El código es requerido');
    }

    // 1. Prioridad absoluta: búsqueda por externalCode exacto
    let customer = await this.prisma.customer.findFirst({
      where: {
        businessId,
        externalCode: cleanCode,
      },
      include: {
        group: {
          select: {
            id: true,
            name: true,
            taxId: true,
            billingCycle: true,
            creditLimit: true,
            isActive: true,
          },
        },
      },
    });

    // 2. Búsqueda secundaria por ruc/teléfono solo si no hubo coincidencia por código exacto
    if (!customer) {
      const orConditions: any[] = [{ ruc: cleanCode }];
      if (cleanCode) {
        orConditions.push({
          phone: cleanCode,
          NOT: [{ phone: null }, { phone: '' }],
        });
      }

      const candidates = await this.prisma.customer.findMany({
        where: {
          businessId,
          OR: orConditions,
        },
        include: {
          group: {
            select: {
              id: true,
              name: true,
              taxId: true,
              billingCycle: true,
              creditLimit: true,
              isActive: true,
            },
          },
        },
        take: 2,
      });

      if (candidates.length > 1) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'AMBIGUOUS_CODE',
          message: {
            code: 'AMBIGUOUS_CODE',
            message: `El código "${cleanCode}" coincide con múltiples clientes por teléfono o RUC. Especifique el carnet exacto`,
          },
        });
      }

      if (candidates.length === 1) {
        customer = candidates[0];
      }
    }

    if (!customer) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        code: 'CUSTOMER_NOT_FOUND',
        message: {
          code: 'CUSTOMER_NOT_FOUND',
          message: `Cliente con código "${cleanCode}" no encontrado`,
        },
      });
    }

    // Saldo actual del cliente en cuentas activas de crédito
    const debtAgg = await this.prisma.creditAccount.aggregate({
      where: {
        customerId: customer.id,
        businessId,
        status: { in: [CreditAccountStatus.PENDING, CreditAccountStatus.PARTIALLY_PAID, CreditAccountStatus.OVERDUE] },
      },
      _sum: { balance: true },
    });
    const balance = debtAgg._sum.balance ? Math.round(Number(debtAgg._sum.balance) * 100) / 100 : 0;

    let availableCredit: number | null = null;
    if (customer.creditLimit !== null && customer.creditLimit !== undefined) {
      availableCredit = Math.max(0, Math.round((Number(customer.creditLimit) - balance) * 100) / 100);
    }

    let groupInfo: any = null;
    if (customer.group) {
      const groupLimit = customer.group.creditLimit !== null && customer.group.creditLimit !== undefined
        ? Number(customer.group.creditLimit)
        : null;

      let groupBalance = 0;
      let groupAvailable: number | null = null;

      if (groupLimit !== null) {
        const groupDebtAgg = await this.prisma.creditAccount.aggregate({
          where: {
            customer: { groupId: customer.group.id },
            businessId,
            status: { in: [CreditAccountStatus.PENDING, CreditAccountStatus.PARTIALLY_PAID, CreditAccountStatus.OVERDUE] },
          },
          _sum: { balance: true },
        });
        groupBalance = groupDebtAgg._sum.balance ? Math.round(Number(groupDebtAgg._sum.balance) * 100) / 100 : 0;
        groupAvailable = Math.max(0, Math.round((groupLimit - groupBalance) * 100) / 100);

        if (availableCredit !== null) {
          availableCredit = Math.min(availableCredit, groupAvailable);
        } else {
          availableCredit = groupAvailable;
        }
      }

      groupInfo = {
        id: customer.group.id,
        name: customer.group.name,
        taxId: customer.group.taxId ?? null,
        billingCycle: customer.group.billingCycle,
        creditLimit: groupLimit,
        balance: groupBalance,
        availableCredit: groupAvailable,
        isActive: customer.group.isActive,
      };
    }

    // Privacidad para rol CAJERO: solo lo indispensable para cobrar
    if (userRole === UserRole.CAJERO) {
      return {
        id: customer.id,
        name: customer.name,
        externalCode: customer.externalCode ?? null,
        currentBalance: balance,
        availableCredit,
        creditLimit: customer.creditLimit !== null && customer.creditLimit !== undefined ? Number(customer.creditLimit) : null,
        creditGroup: customer.group
          ? {
              id: customer.group.id,
              name: customer.group.name,
            }
          : null,
      };
    }

    // Para ENCARGADO / SUPERADMIN: respuesta completa
    return {
      id: customer.id,
      businessId: customer.businessId,
      name: customer.name,
      phone: customer.phone,
      email: customer.email ?? null,
      address: customer.lastAddressText ?? null,
      ruc: customer.ruc ?? null,
      externalCode: customer.externalCode ?? null,
      creditLimit: customer.creditLimit !== null && customer.creditLimit !== undefined ? Number(customer.creditLimit) : null,
      balance,
      currentBalance: balance,
      availableCredit,
      groupId: customer.groupId ?? null,
      creditGroup: groupInfo,
      group: groupInfo,
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
    };
  }
}

