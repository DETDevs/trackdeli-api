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

    const [business, hasCartera] = await Promise.all([
      this.prisma.business.findUnique({
        where: { id: businessId },
        select: { customerLocationMaxDays: true },
      }),
      this.businessProductsService.isActive(
        businessId,
        BusinessProductType.CARTERA_COBRO,
      ),
    ]);
    const maxDays = business?.customerLocationMaxDays ?? 30;

    const where: Prisma.CustomerWhereInput = {
      businessId,
      isActive: true,
      ...(hasCartera && groupId && groupId.trim() ? { groupId: groupId.trim() } : {}),
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
      creditLimit: hasCartera ? (c.creditLimit ?? null) : null,
      groupId: hasCartera ? (c.groupId ?? null) : null,
      externalCode: c.externalCode ?? null,
      isActive: c.isActive,
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

    const [customer, business, hasCartera] = await Promise.all([
      this.prisma.customer.findUnique({
        where: {
          businessId_phone: {
            businessId,
            phone: trimmed,
          },
        },
      }),
      this.prisma.business.findUnique({
        where: { id: businessId },
        select: { customerLocationMaxDays: true },
      }),
      this.businessProductsService.isActive(
        businessId,
        BusinessProductType.CARTERA_COBRO,
      ),
    ]);

    if (!customer) {
      throw new NotFoundException('Cliente no encontrado');
    }

    const maxDays = business?.customerLocationMaxDays ?? 30;

    return {
      id: customer.id,
      businessId: customer.businessId,
      name: customer.name,
      phone: customer.phone,
      email: customer.email ?? null,
      notes: customer.notes ?? null,
      ruc: customer.ruc ?? null,
      creditLimit: hasCartera ? (customer.creditLimit ?? null) : null,
      groupId: hasCartera ? (customer.groupId ?? null) : null,
      externalCode: customer.externalCode ?? null,
      isActive: customer.isActive,
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

  /** 207a: recorta el texto; vacío = null. */
  private cleanText(value?: string | null): string | null {
    if (value === undefined || value === null) return null;
    const trimmed = String(value).trim();
    return trimmed === '' ? null : trimmed;
  }

  /**
   * 207a: determina si un límite de crédito representa un valor real y positivo (> 0).
   * Valores null, undefined, "" o 0 se consideran no configurados / ignorables.
   */
  private isCreditLimitSet(val?: number | string | null): boolean {
    if (val === undefined || val === null || val === '') return false;
    const num = Number(val);
    return !Number.isNaN(num) && num > 0;
  }

  /**
   * 207a: determina si un groupId representa una empresa real (no nula ni vacía).
   */
  private isGroupIdSet(val?: string | null): boolean {
    if (val === undefined || val === null) return false;
    return String(val).trim().length > 0;
  }

  /**
   * 207a: busca posibles duplicados dentro del negocio.
   * - Cédula/RUC: otro cliente ACTIVO con el mismo valor (aviso, se puede confirmar).
   * - Teléfono: igual exacto = bloqueante (restricción única de la base, incluye inactivos);
   *   variante equivalente de un cliente activo = aviso.
   */
  private async findDuplicates(
    businessId: string,
    keys: { ruc?: string | null; phone?: string | null },
    excludeId?: string | null,
    userRole?: UserRole,
  ) {
    const found: {
      field: 'documentId' | 'phone';
      blocking: boolean;
      customer: Record<string, any>;
    }[] = [];
    const select = {
      id: true,
      name: true,
      phone: true,
      ruc: true,
      email: true,
      isActive: true,
    } as const;
    const present = (c: any) => ({
      id: c.id,
      name: c.name,
      phone: c.phone ?? null,
      email: c.email ?? null,
      documentId: userRole === UserRole.CAJERO ? null : (c.ruc ?? null),
      isActive: c.isActive,
    });
    const notSelf = excludeId ? { id: { not: excludeId } } : {};

    if (keys.ruc) {
      const rows = await this.prisma.customer.findMany({
        where: {
          businessId,
          isActive: true,
          ruc: { equals: keys.ruc, mode: 'insensitive' },
          ...notSelf,
        },
        select,
        take: 5,
      });
      for (const c of rows) {
        found.push({ field: 'documentId', blocking: false, customer: present(c) });
      }
    }

    if (keys.phone) {
      const rows = await this.prisma.customer.findMany({
        where: {
          businessId,
          phone: { in: this.getPhoneVariants(keys.phone) },
          ...notSelf,
        },
        select,
        take: 5,
      });
      for (const c of rows) {
        const exact = c.phone === keys.phone;
        if (!exact && !c.isActive) continue;
        found.push({ field: 'phone', blocking: exact, customer: present(c) });
      }
    }
    return found;
  }

  /** 207a: lanza 409 DUPLICATE_CUSTOMER con el cliente existente si corresponde avisar. */
  private async assertNoDuplicates(
    businessId: string,
    keys: { ruc?: string | null; phone?: string | null },
    excludeId: string | null,
    confirmed: boolean,
    userRole?: UserRole,
  ) {
    const found = await this.findDuplicates(businessId, keys, excludeId, userRole);
    if (found.length === 0) return;
    const canConfirm = found.every((d) => !d.blocking);
    if (canConfirm && confirmed) return;
    const first = found[0];
    const what = found.some((d) => d.blocking)
      ? 'Ya existe un cliente con ese teléfono'
      : first.field === 'documentId'
      ? 'Ya existe un cliente activo con esa cédula/RUC'
      : 'Ya existe un cliente activo con un teléfono equivalente';
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: 'DUPLICATE_CUSTOMER',
      message: `${what} (${first.customer.name})`,
      canConfirm,
      duplicates: found,
    });
  }

  async create(
    businessId: string,
    dto: CreateCustomerDto,
    userRole?: UserRole,
  ): Promise<CustomerResponseDto> {
    const name = this.cleanText(dto.name);
    const phone = this.cleanText(dto.phone);
    const ruc = this.cleanText(dto.documentId ?? dto.ruc);

    if (!name) {
      throw new BadRequestException('El nombre del cliente es requerido');
    }
    // Cobro (191): sin checkDuplicates el teléfono sigue siendo obligatorio.
    if (!phone && !dto.checkDuplicates) {
      throw new BadRequestException('El número de teléfono es requerido');
    }

    if (dto.checkDuplicates) {
      await this.assertNoDuplicates(
        businessId,
        { ruc, phone },
        null,
        dto.confirmDuplicates === true,
        userRole,
      );
    } else if (phone) {
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

    const hasCartera = await this.businessProductsService.isActive(
      businessId,
      BusinessProductType.CARTERA_COBRO,
    );

    // Sin Finanzas: solo rechaza si intenta asignar límite de crédito > 0 o empresa real
    if (!hasCartera) {
      if (this.isCreditLimitSet(dto.creditLimit) || this.isGroupIdSet(dto.groupId)) {
        throw new ForbiddenException('Este negocio no tiene Finanzas contratada');
      }
    }

    // CAJERO en POST:
    // Si creditLimit, groupId o isBlocked vienen null, vacíos, 0 o false, ignorar sin error.
    // Dar 403 solo si el CAJERO intenta poner un valor distinto (ej. creditLimit > 0, groupId real, isBlocked: true).
    const isCajero = userRole === UserRole.CAJERO;
    if (isCajero) {
      if (this.isCreditLimitSet(dto.creditLimit) || this.isGroupIdSet(dto.groupId)) {
        throw new ForbiddenException(
          'Solo el encargado puede definir el límite de crédito o la empresa del cliente',
        );
      }
      if (dto.isBlocked === true) {
        throw new ForbiddenException(
          'Solo el encargado puede cambiar el límite de crédito, la empresa o el bloqueo del cliente',
        );
      }
    }

    const hasValidGroup = this.isGroupIdSet(dto.groupId);
    if (hasValidGroup) {
      const group = await this.prisma.creditGroup.findFirst({
        where: { id: dto.groupId!.trim(), businessId },
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
        email: this.cleanText(dto.email),
        notes: this.cleanText(dto.notes),
        ruc,
        creditLimit:
          !isCajero && hasCartera && this.isCreditLimitSet(dto.creditLimit)
            ? Number(dto.creditLimit)
            : null,
        groupId:
          !isCajero && hasCartera && hasValidGroup
            ? dto.groupId!.trim()
            : null,
        externalCode: dto.externalCode?.trim() || null,
        lastAddressText: dto.address?.trim() || null,
        isBlocked: !isCajero && dto.isBlocked === true,
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
      creditLimit: hasCartera && !isCajero ? (customer.creditLimit ?? null) : null,
      groupId: hasCartera && !isCajero ? (customer.groupId ?? null) : null,
      group: hasCartera && !isCajero ? (customer.group ?? null) : null,
      externalCode: customer.externalCode ?? null,
      email: customer.email ?? null,
      notes: customer.notes ?? null,
      isActive: customer.isActive,
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
      status?: string;
    } = {},
    userRole?: UserRole,
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

    // 207a: status=active|inactive filtra por estado; sin status (o 'all') lista todos como antes.
    const statusFilter = (options.status ?? '').toString().trim().toLowerCase();
    if (statusFilter === 'active') where.isActive = true;
    else if (statusFilter === 'inactive') where.isActive = false;

    const hasCartera = await this.businessProductsService.isActive(
      businessId,
      BusinessProductType.CARTERA_COBRO,
    );

    // Filtro por groupId si viene especificado
    if (options.groupId && options.groupId.trim()) {
      if (!hasCartera) {
        throw new ForbiddenException('Este negocio no tiene Finanzas contratada');
      }
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
      hasCartera &&
      (options.onlyWithBalance === true ||
        options.onlyWithBalance === 'true' ||
        options.onlyWithBalance === '1');

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

    const isCajero = userRole === UserRole.CAJERO;
    const items = customers.map((c) => {
      const currentBalance = hasCartera
        ? (c.creditAccounts || []).reduce(
            (sum, ca) => sum + (Number(ca.balance) || 0),
            0,
          )
        : 0;
      const roundedBalance = hasCartera ? Math.round(currentBalance * 100) / 100 : null;
      return {
        id: c.id,
        businessId: c.businessId,
        name: c.name,
        phone: c.phone,
        email: c.email ?? null,
        notes: c.notes ?? null,
        ruc: isCajero ? null : (c.ruc ?? null),
        creditLimit: !hasCartera || isCajero
          ? null
          : c.creditLimit !== null && c.creditLimit !== undefined
          ? Number(c.creditLimit)
          : null,
        groupId: hasCartera ? (c.groupId ?? null) : null,
        externalCode: c.externalCode ?? null,
        group: hasCartera ? (c.group ?? null) : null,
        isBlocked: c.isBlocked,
        isActive: c.isActive,
        consecutiveNoShows: c.consecutiveNoShows,
        lastAddressText: c.lastAddressText ?? null,
        currentBalance: roundedBalance,
        balance: roundedBalance,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        _count: {
          ...c._count,
          creditAccounts: hasCartera ? c._count.creditAccounts : 0,
        },
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
    const [customer, hasCartera] = await Promise.all([
      this.prisma.customer.findFirst({
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
      }),
      this.businessProductsService.isActive(
        businessId,
        BusinessProductType.CARTERA_COBRO,
      ),
    ]);

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
      creditLimit: hasCartera ? customer.creditLimit : null,
      groupId: hasCartera ? customer.groupId : null,
      orders,
      sales,
      _count: {
        ...customer._count,
        creditAccounts: hasCartera ? customer._count.creditAccounts : 0,
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
        creditLimit: isCarteraActive ? customer.creditLimit : null,
        ruc: customer.ruc,
        isBlocked: customer.isBlocked,
        isActive: customer.isActive,
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
    userRole?: UserRole,
  ) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, businessId },
    });

    if (!customer) {
      throw new NotFoundException('Cliente no encontrado');
    }

    const hasCartera = await this.businessProductsService.isActive(
      businessId,
      BusinessProductType.CARTERA_COBRO,
    );

    const isCajero = userRole === UserRole.CAJERO;

    // Validación sin Finanzas:
    // Solo rechazar si intenta asignar o cambiar a un límite > 0 o una empresa real.
    // Si viene null, vacío, 0 o igual al actual, ignorar sin error.
    if (!hasCartera) {
      const attemptsLimit =
        dto.creditLimit !== undefined &&
        this.isCreditLimitSet(dto.creditLimit) &&
        Number(dto.creditLimit) !== Number(customer.creditLimit);
      const attemptsGroup =
        dto.groupId !== undefined &&
        this.isGroupIdSet(dto.groupId) &&
        dto.groupId!.trim() !== (customer.groupId ?? '');

      if (attemptsLimit || attemptsGroup) {
        throw new ForbiddenException('Este negocio no tiene Finanzas contratada');
      }
    }

    // CAJERO en PATCH:
    // "si creditLimit, groupId o isBlocked vienen null, vacíos, 0 o iguales al valor actual,
    // ignoralos sin error. Dá 403 solo si el CAJERO intenta poner un valor distinto (ej. creditLimit 5000)."
    let allowUpdateCreditLimit = !isCajero;
    let allowUpdateGroup = !isCajero;
    let allowUpdateBlocked = !isCajero;

    if (isCajero) {
      if (dto.creditLimit !== undefined) {
        const isIgnoredLimit =
          dto.creditLimit === null ||
          (dto.creditLimit as any) === '' ||
          Number(dto.creditLimit) === 0 ||
          (customer.creditLimit != null && Number(dto.creditLimit) === Number(customer.creditLimit));
        if (!isIgnoredLimit) {
          throw new ForbiddenException(
            'Solo el encargado puede cambiar el límite de crédito, la empresa o el bloqueo del cliente',
          );
        }
        allowUpdateCreditLimit = false;
      }

      if (dto.groupId !== undefined) {
        const cleanGid = dto.groupId ? String(dto.groupId).trim() : '';
        const currentGid = customer.groupId ? String(customer.groupId).trim() : '';
        const isIgnoredGroup = cleanGid === '' || cleanGid === currentGid;
        if (!isIgnoredGroup) {
          throw new ForbiddenException(
            'Solo el encargado puede cambiar el límite de crédito, la empresa o el bloqueo del cliente',
          );
        }
        allowUpdateGroup = false;
      }

      if (dto.isBlocked !== undefined) {
        const isIgnoredBlocked =
          dto.isBlocked === null ||
          dto.isBlocked === undefined ||
          dto.isBlocked === customer.isBlocked;
        if (!isIgnoredBlocked) {
          throw new ForbiddenException(
            'Solo el encargado puede cambiar el límite de crédito, la empresa o el bloqueo del cliente',
          );
        }
        allowUpdateBlocked = false;
      }
    }

    if (dto.name !== undefined && !this.cleanText(dto.name)) {
      throw new BadRequestException('El nombre del cliente no puede quedar vacío');
    }
    const newPhone = dto.phone !== undefined ? this.cleanText(dto.phone) : undefined;
    const rawDoc = dto.documentId !== undefined ? dto.documentId : dto.ruc;
    const newRuc = rawDoc !== undefined ? this.cleanText(rawDoc) : undefined;

    const phoneChanged = newPhone !== undefined && newPhone !== (customer.phone ?? null);
    const rucChanged = newRuc !== undefined && newRuc !== (customer.ruc ?? null);

    if (dto.checkDuplicates) {
      if (phoneChanged || rucChanged) {
        await this.assertNoDuplicates(
          businessId,
          {
            ruc: rucChanged ? newRuc : null,
            phone: phoneChanged ? newPhone : null,
          },
          id,
          dto.confirmDuplicates === true,
          userRole,
        );
      }
    } else if (phoneChanged && newPhone) {
      const existing = await this.prisma.customer.findUnique({
        where: {
          businessId_phone: {
            businessId,
            phone: newPhone,
          },
        },
      });
      if (existing && existing.id !== id) {
        throw new ConflictException(
          `Ya existe otro cliente con el teléfono ${newPhone}`,
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

    if (allowUpdateGroup && dto.groupId !== undefined && this.isGroupIdSet(dto.groupId)) {
      const group = await this.prisma.creditGroup.findFirst({
        where: { id: dto.groupId!.trim(), businessId },
      });
      if (!group) {
        throw new BadRequestException('La empresa/convenio especificada no existe');
      }
    }

    const hasNewCoords = dto.latitude != null && dto.longitude != null;
    const now = new Date();

    const updated = await this.prisma.customer.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: this.cleanText(dto.name)! }),
        ...(newPhone !== undefined && { phone: newPhone }),
        ...(dto.email !== undefined && { email: this.cleanText(dto.email) }),
        ...(dto.notes !== undefined && { notes: this.cleanText(dto.notes) }),
        ...(newRuc !== undefined && { ruc: newRuc }),
        ...(allowUpdateCreditLimit && dto.creditLimit !== undefined && {
          creditLimit:
            hasCartera && this.isCreditLimitSet(dto.creditLimit)
              ? Number(dto.creditLimit)
              : null,
        }),
        ...(allowUpdateGroup && dto.groupId !== undefined && {
          groupId:
            hasCartera && this.isGroupIdSet(dto.groupId)
              ? dto.groupId!.trim()
              : null,
        }),
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
        ...(allowUpdateBlocked && dto.isBlocked !== undefined && {
          isBlocked: Boolean(dto.isBlocked),
        }),
      },
      include: {
        group: {
          select: { id: true, name: true, taxId: true },
        },
      },
    });

    if (!hasCartera) {
      return {
        ...updated,
        creditLimit: null,
        groupId: null,
        group: null,
      };
    }
    if (isCajero) {
      return { ...updated, creditLimit: null };
    }
    return updated;
  }

  /**
   * 207a: activar/desactivar. Un cliente desactivado no aparece en la búsqueda del cobro
   * pero conserva ventas, créditos e historial.
   */
  async setStatus(businessId: string, id: string, isActive: boolean) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, businessId },
      select: { id: true },
    });
    if (!customer) {
      throw new NotFoundException('Cliente no encontrado');
    }
    const updated = await this.prisma.customer.update({
      where: { id },
      data: { isActive },
      select: { id: true, name: true, isActive: true, updatedAt: true },
    });
    return updated;
  }

  /**
   * 207a (opcional): borrado real solo si el cliente no tiene ningún movimiento.
   * Con ventas, créditos, citas, comandas, vehículos o cortes se rechaza y se sugiere desactivar.
   */
  async remove(businessId: string, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, businessId },
      include: {
        _count: {
          select: {
            sales: true,
            creditAccounts: true,
            appointments: true,
            tableOrders: true,
            workshopVehicles: true,
            statementItems: true,
          },
        },
      },
    });
    if (!customer) {
      throw new NotFoundException('Cliente no encontrado');
    }
    const movements = Object.values(customer._count).reduce((a, b) => a + b, 0);
    if (movements > 0) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'CUSTOMER_HAS_HISTORY',
        message:
          'No se puede eliminar un cliente con ventas, créditos o movimientos. Puedes desactivarlo para conservar su historial.',
        counts: customer._count,
      });
    }
    await this.prisma.customer.delete({ where: { id } });
    return { deleted: true, id };
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

    const hasCartera = await this.businessProductsService.isActive(
      businessId,
      BusinessProductType.CARTERA_COBRO,
    );

    // Saldo actual del cliente en cuentas activas de crédito solo si tiene Cartera de Cobro
    let balance: number | null = null;
    let availableCredit: number | null = null;
    let groupInfo: any = null;

    if (hasCartera) {
      const debtAgg = await this.prisma.creditAccount.aggregate({
        where: {
          customerId: customer.id,
          businessId,
          status: { in: [CreditAccountStatus.PENDING, CreditAccountStatus.PARTIALLY_PAID, CreditAccountStatus.OVERDUE] },
        },
        _sum: { balance: true },
      });
      const numBalance = debtAgg._sum.balance ? Math.round(Number(debtAgg._sum.balance) * 100) / 100 : 0;
      balance = numBalance;

      if (customer.creditLimit !== null && customer.creditLimit !== undefined) {
        availableCredit = Math.max(0, Math.round((Number(customer.creditLimit) - numBalance) * 100) / 100);
      }

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
    }

    // Privacidad para rol CAJERO: solo lo indispensable para cobrar
    if (userRole === UserRole.CAJERO) {
      return {
        id: customer.id,
        name: customer.name,
        externalCode: customer.externalCode ?? null,
        currentBalance: balance,
        availableCredit,
        creditLimit: hasCartera && customer.creditLimit !== null && customer.creditLimit !== undefined ? Number(customer.creditLimit) : null,
        creditGroup: hasCartera && customer.group
          ? {
              id: customer.group.id,
              name: customer.group.name,
            }
          : null,
        isActive: customer.isActive,
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
      creditLimit: hasCartera && customer.creditLimit !== null && customer.creditLimit !== undefined ? Number(customer.creditLimit) : null,
      balance,
      currentBalance: balance,
      availableCredit,
      groupId: hasCartera ? (customer.groupId ?? null) : null,
      creditGroup: groupInfo,
      group: groupInfo,
      isActive: customer.isActive,
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
    };
  }
}

