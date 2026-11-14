import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { PoliciesService } from '../policies/policies.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { BatchesService } from '../batches/batches.service';
import { PosAction } from '../permissions/permissions.service';
import {
  addDaysToDateStr,
  buildBusinessDateRange,
  DEFAULT_BUSINESS_TIMEZONE,
  formatDateInTimezone,
  getEndOfDayInTimezone,
} from '../../../common/utils/date.util';
import {
  calculateSaleTotals,
  RawSaleItemCalculationInput,
} from '../sales/utils/sale-calculation.util';
import { resolveLineUnitPrice } from '../sales/utils/pricing.util';
import { round3, validateProductQuantity } from '../products/product-unit.util';
import { CreateQuoteDto, CreateQuoteItemDto } from './dto/create-quote.dto';
import { UpdateQuoteDto } from './dto/update-quote.dto';
import { UpdateQuoteStatusDto } from './dto/update-quote-status.dto';
import { ListQuotesQueryDto } from './dto/list-quotes-query.dto';
import { DuplicateQuoteDto } from './dto/duplicate-quote.dto';
import {
  DEFAULT_QUOTE_VALIDITY_DAYS,
  QUOTE_CURRENCY,
  QUOTE_ERROR_CODES,
  QUOTE_PREFIX,
  QUOTE_STATUS,
} from './pos-quotes.constants';

function round2(n: number): number {
  return Math.round(Number(n || 0) * 100) / 100;
}

function formatDateDdMmYyyy(date: Date | string): string {
  const ymd = formatDateInTimezone(date, DEFAULT_BUSINESS_TIMEZONE);
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y}`;
}

function calculateExpiresAt(validityDays: number, now: Date): Date {
  const baseDateStr = formatDateInTimezone(now, DEFAULT_BUSINESS_TIMEZONE);
  const targetDateStr = addDaysToDateStr(baseDateStr, validityDays);
  return getEndOfDayInTimezone(targetDateStr, DEFAULT_BUSINESS_TIMEZONE);
}

@Injectable()
export class PosQuotesService {
  private readonly logger = new Logger(PosQuotesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policiesService: PoliciesService,
    private readonly approvalsService: ApprovalsService,
    private readonly batchesService: BatchesService,
  ) {}

  private formatQuoteItem(item: any) {
    return {
      id: item.id,
      quoteId: item.quoteId,
      sortOrder: item.sortOrder,
      productId: item.productId || null,
      productName: item.productName,
      barcode: item.barcode || null,
      unit: item.unit || 'UND',
      itemType: item.itemType || (item.productId ? 'PRODUCT' : 'CUSTOM'),
      quantity: Number(item.quantity),
      unitPrice: round2(item.unitPrice),
      priceTier: item.priceTier || 'RETAIL',
      priceOverride: Boolean(item.priceOverride),
      discount: round2(item.discount || 0),
      subtotal: round2(item.subtotal),
      listPrice: item.listPrice != null ? round2(item.listPrice) : null,
      listPriceDiscount: round2(item.listPriceDiscount || 0),
      manualDiscountShare: round2(item.manualDiscountShare || 0),
      taxable: Boolean(item.taxable),
      taxRate: round2(item.taxRate || 0),
      taxAmount: round2(item.taxAmount || 0),
      total: round2(item.total || 0),
      notes: item.notes || null,
    };
  }

  private formatQuote(quote: any, issuer?: any) {
    if (!quote) return null;
    const formatted: any = {
      id: quote.id,
      businessId: quote.businessId,
      number: quote.number,
      quoteNumber: quote.quoteNumber,
      status: quote.status,
      createdById: quote.createdById,
      createdByName: quote.createdByName,
      customerId: quote.customerId || null,
      customerName: quote.customerName || null,
      customerPhone: quote.customerPhone || null,
      customerRuc: quote.customerRuc || null,
      customerAddress: quote.customerAddress || null,
      vehicleInfo: quote.vehicleInfo || null,
      validityDays: quote.validityDays,
      expiresAt: quote.expiresAt,
      validUntilLabel: formatDateDdMmYyyy(quote.expiresAt),
      notes: quote.notes || null,
      conditions: quote.conditions || null,
      subtotal: round2(quote.subtotal),
      discountAmount: round2(quote.discountAmount || 0),
      listPriceTotal: round2(quote.listPriceTotal || 0),
      listDiscountTotal: round2(quote.listDiscountTotal || 0),
      taxModel: quote.taxModel || 'PER_LINE',
      taxRate: round2(quote.taxRate || 0),
      taxEnabled: Boolean(quote.taxEnabled),
      taxIncluded: Boolean(quote.taxIncluded),
      taxAmount: round2(quote.taxAmount || 0),
      total: round2(quote.total),
      currency: quote.currency || QUOTE_CURRENCY,
      sentAt: quote.sentAt || null,
      acceptedAt: quote.acceptedAt || null,
      convertedAt: quote.convertedAt || null,
      convertedById: quote.convertedById || null,
      convertedSaleId: quote.convertedSaleId || null,
      cancelledAt: quote.cancelledAt || null,
      cancelledById: quote.cancelledById || null,
      cancelReason: quote.cancelReason || null,
      expiredAt: quote.expiredAt || null,
      clientRequestId: quote.clientRequestId || null,
      createdAt: quote.createdAt,
      updatedAt: quote.updatedAt,
      items: (quote.items || []).map((it: any) => this.formatQuoteItem(it)),
    };
    if (quote._count?.items !== undefined && (!quote.items || quote.items.length === 0)) {
      formatted.itemsCount = quote._count.items;
    } else if (Array.isArray(quote.items)) {
      formatted.itemsCount = quote.items.length;
    }
    if (issuer !== undefined) {
      formatted.issuer = issuer;
    }
    return formatted;
  }

  private buildIssuerBlock(business: any, settings: any) {
    const showBusinessName = settings?.showBusinessName ?? true;
    const showTaxId = settings?.showTaxId ?? true;
    const showAddress = settings?.showAddress ?? true;
    const showPhone = settings?.showPhone ?? true;
    const showLogo = settings?.showLogo ?? false;

    const footerLines =
      settings?.footerLines && settings.footerLines.length > 0
        ? settings.footerLines
        : business.posFooter
          ? [business.posFooter]
          : [];

    return {
      name: showBusinessName ? business.name || null : null,
      taxId: showTaxId ? business.taxId || null : null,
      address: showAddress ? business.posAddress || null : null,
      phone: showPhone ? business.posPhone || business.whatsappNumber || null : null,
      logoUrl: showLogo ? settings?.logoImage || business.logoUrl || null : null,
      headerLines: settings?.headerLines || [],
      footerLines,
    };
  }

  async sweepExpiredQuotes(businessId: string): Promise<number> {
    const now = new Date();
    const affected = await this.prisma.$executeRaw`
      UPDATE "pos_quotes"
      SET "status" = ${QUOTE_STATUS.EXPIRED},
          "expiredAt" = COALESCE("expiredAt", ${now}),
          "updatedAt" = ${now}
      WHERE "businessId" = ${businessId}
        AND "status" IN (${QUOTE_STATUS.DRAFT}, ${QUOTE_STATUS.SENT}, ${QUOTE_STATUS.ACCEPTED})
        AND "expiresAt" < ${now};
    `;
    return Number(affected || 0);
  }

  private async getBusinessContext(tx: Prisma.TransactionClient, businessId: string) {
    const business = await tx.business.findUnique({
      where: { id: businessId },
      select: {
        id: true,
        name: true,
        taxId: true,
        posAddress: true,
        posPhone: true,
        whatsappNumber: true,
        posFooter: true,
        logoUrl: true,
        currency: true,
        wholesaleEnabled: true,
        tracksBatches: true,
        useListPrice: true,
        taxRate: true,
        taxEnabled: true,
        taxIncluded: true,
      },
    });
    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }
    return business;
  }

  private async resolveCustomerSnapshot(
    tx: Prisma.TransactionClient,
    businessId: string,
    input: {
      customerId?: string | null;
      customerName?: string | null;
      customerPhone?: string | null;
      customerRuc?: string | null;
      customerAddress?: string | null;
    },
  ) {
    let customerId: string | null = input.customerId ? input.customerId.trim() : null;
    let customerName: string | null = input.customerName?.trim() || null;
    let customerPhone: string | null = input.customerPhone?.trim() || null;
    let customerRuc: string | null = input.customerRuc?.trim() || null;
    let customerAddress: string | null = input.customerAddress?.trim() || null;

    if (customerId) {
      const customer = await tx.customer.findFirst({
        where: { id: customerId, businessId },
        select: {
          id: true,
          name: true,
          phone: true,
          ruc: true,
          lastAddressText: true,
        },
      });
      if (!customer) {
        throw new NotFoundException({
          statusCode: 404,
          code: QUOTE_ERROR_CODES.CUSTOMER_NOT_FOUND,
          message: 'Cliente no encontrado o no pertenece a este negocio',
        });
      }
      customerId = customer.id;
      if (!customerName) customerName = customer.name;
      if (!customerPhone) customerPhone = customer.phone;
      if (!customerRuc) customerRuc = customer.ruc;
      if (!customerAddress) customerAddress = customer.lastAddressText;
    }

    return {
      customerId,
      customerName,
      customerPhone,
      customerRuc,
      customerAddress,
    };
  }

  private async prepareQuoteItemsAndTotals(
    tx: Prisma.TransactionClient,
    params: {
      businessId: string;
      business: any;
      policies: any;
      userRole: string;
      items: CreateQuoteItemDto[];
      discountAmount?: number;
      approvalToken?: string;
      missingProductStatus?: 'NOT_FOUND' | 'UNPROCESSABLE';
    },
  ) {
    const {
      businessId,
      business,
      policies,
      userRole,
      items,
      discountAmount = 0,
      approvalToken,
      missingProductStatus = 'NOT_FOUND',
    } = params;

    if (!items || items.length === 0) {
      throw new BadRequestException('La proforma debe contener al menos una línea');
    }

    const productIds = Array.from(
      new Set(
        items
          .map((i) => (i.productId ? i.productId.trim() : null))
          .filter((id): id is string => Boolean(id)),
      ),
    );

    const products = productIds.length
      ? await tx.product.findMany({
          where: { id: { in: productIds }, businessId },
        })
      : [];
    const productMap = new Map(products.map((p) => [p.id, p]));

    const isPrivileged =
      userRole === UserRole.ENCARGADO || userRole === UserRole.SUPERADMIN;
    const isSeller = userRole === UserRole.VENDEDOR;

    const rawItemsForCalc: RawSaleItemCalculationInput[] = [];
    const itemMeta: Array<{
      unit: string;
      itemType: 'PRODUCT' | 'SERVICE' | 'CUSTOM';
      priceOverride: boolean;
      notes: string | null;
      sortOrder: number;
    }> = [];

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      const cleanProductId = item.productId ? item.productId.trim() : null;

      if (!cleanProductId) {
        if (isSeller) {
          throw new ForbiddenException({
            statusCode: 403,
            error: 'Forbidden',
            code: QUOTE_ERROR_CODES.FREE_LINE_NOT_ALLOWED,
            message:
              'Los vendedores no pueden agregar líneas libres; solo productos y servicios del catálogo',
          });
        }

        const cleanName = (item.productName || '').trim();
        if (!cleanName) {
          throw new BadRequestException({
            statusCode: 400,
            code: QUOTE_ERROR_CODES.FREE_LINE_NAME_REQUIRED,
            message: 'Toda línea libre debe incluir una descripción',
          });
        }

        if (item.unitPrice === undefined || item.unitPrice === null || Number(item.unitPrice) < 0) {
          throw new BadRequestException({
            statusCode: 400,
            code: QUOTE_ERROR_CODES.FREE_LINE_PRICE_REQUIRED,
            message: `La línea libre "${cleanName}" debe incluir un precio unitario válido`,
          });
        }

        const qty = round3(Number(item.quantity));
        if (!Number.isFinite(qty) || qty < 0.001) {
          throw new BadRequestException('La cantidad mínima para una línea libre es 0.001');
        }

        const cleanUnit = (item.unit || 'UND').trim().toUpperCase().substring(0, 10) || 'UND';

        rawItemsForCalc.push({
          productId: null,
          productName: cleanName.substring(0, 200),
          barcode: null,
          unitPrice: round2(Number(item.unitPrice)),
          quantity: qty,
          discount: round2(Number(item.discount || 0)),
          priceTier: 'RETAIL',
          listPrice: null,
          taxable: Boolean(item.taxable),
        });

        itemMeta.push({
          unit: cleanUnit,
          itemType: 'CUSTOM',
          priceOverride: false,
          notes: item.notes ? item.notes.trim().substring(0, 500) : null,
          sortOrder: idx,
        });
        continue;
      }

      const product = productMap.get(cleanProductId);
      if (!product) {
        if (missingProductStatus === 'UNPROCESSABLE') {
          throw new UnprocessableEntityException({
            statusCode: 422,
            code: QUOTE_ERROR_CODES.PRODUCT_NOT_AVAILABLE,
            message: `El producto "${item.productName || cleanProductId}" ya no existe en el catálogo`,
          });
        }
        throw new NotFoundException({
          statusCode: 404,
          code: QUOTE_ERROR_CODES.PRODUCT_NOT_FOUND,
          message: `Producto ${cleanProductId} no encontrado`,
        });
      }

      if (!product.isActive) {
        if (missingProductStatus === 'UNPROCESSABLE') {
          throw new UnprocessableEntityException({
            statusCode: 422,
            code: QUOTE_ERROR_CODES.PRODUCT_NOT_AVAILABLE,
            message: `El producto "${product.name}" está inactivo en el catálogo`,
          });
        }
        throw new BadRequestException({
          statusCode: 400,
          code: QUOTE_ERROR_CODES.PRODUCT_INACTIVE,
          message: `El producto "${product.name}" está inactivo`,
        });
      }

      const qty = validateProductQuantity(product.unit, Number(item.quantity), product.name, false);
      const resolved = resolveLineUnitPrice(product, qty, business);

      let unitPrice = resolved.unitPrice;
      let priceOverride = false;

      if (isPrivileged && item.unitPrice !== undefined && item.unitPrice !== null) {
        const clientPrice = Number(item.unitPrice);
        const diff = Math.abs(clientPrice - resolved.unitPrice);
        if (diff > 0.01) {
          if (!policies.priceOverrideEnabled) {
            throw new BadRequestException({
              statusCode: 400,
              error: 'Bad Request',
              code: QUOTE_ERROR_CODES.PRICE_MISMATCH,
              message: `El precio unitario enviado (${clientPrice}) no coincide con el precio correspondiente (${resolved.unitPrice}) para "${product.name}"`,
            });
          }
          unitPrice = round2(clientPrice);
          priceOverride = true;
        }
      }

      const listPrice =
        business.useListPrice && product.listPrice != null
          ? Number(product.listPrice)
          : null;

      rawItemsForCalc.push({
        productId: product.id,
        productName: product.name,
        barcode: product.barcode || null,
        unitPrice,
        quantity: qty,
        discount: round2(Number(item.discount || 0)),
        priceTier: resolved.priceTier,
        listPrice,
        taxable: Boolean(product.taxable),
      });

      itemMeta.push({
        unit: product.unit || 'UND',
        itemType: product.type === 'SERVICE' ? 'SERVICE' : 'PRODUCT',
        priceOverride,
        notes: item.notes ? item.notes.trim().substring(0, 500) : null,
        sortOrder: idx,
      });
    }

    const requestedDiscount = Math.max(0, round2(discountAmount || 0));
    const calcResult = calculateSaleTotals(rawItemsForCalc, requestedDiscount, business);

    if (requestedDiscount > 0) {
      if (!policies.discountsEnabled) {
        throw new ForbiddenException({
          statusCode: 403,
          code: QUOTE_ERROR_CODES.DISCOUNTS_DISABLED,
          message: 'Los descuentos están deshabilitados en este negocio',
        });
      }

      if (isSeller) {
        throw new ForbiddenException({
          statusCode: 403,
          code: QUOTE_ERROR_CODES.DISCOUNT_NOT_ALLOWED,
          message: 'Los vendedores no tienen permiso para aplicar descuentos globales',
        });
      }

      if (userRole === UserRole.CAJERO) {
        const subtotalBase = calcResult.subtotal;
        const maxAllowedPercent = policies.cashierMaxDiscountPercent ?? 10;
        const discountPercent =
          subtotalBase > 0 ? (requestedDiscount / subtotalBase) * 100 : 0;

        if (discountPercent > maxAllowedPercent + 0.01) {
          if (approvalToken) {
            await this.approvalsService.consumeToken(
              businessId,
              PosAction.APLICAR_DESCUENTO,
              approvalToken,
              tx,
            );
          } else {
            throw new ForbiddenException({
              statusCode: 403,
              code: QUOTE_ERROR_CODES.DISCOUNT_LIMIT_EXCEEDED,
              message: `El descuento aplicado (${discountPercent.toFixed(1)}%) supera el tope permitido para cajeros (${maxAllowedPercent}%). Requiere autorización de encargado.`,
              maxAllowedPercent,
              requestedPercent: discountPercent,
            });
          }
        }
      }
    }

    const quoteItemsCreateData = calcResult.lines.map((l, idx) => {
      const meta = itemMeta[idx];
      const lineTotal = round2(l.subtotal - l.manualDiscountShare + l.taxAmount);
      return {
        sortOrder: meta.sortOrder,
        productId: l.productId || null,
        productName: l.productName,
        barcode: l.barcode || null,
        unit: meta.unit,
        itemType: meta.itemType,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        priceTier: l.priceTier,
        priceOverride: meta.priceOverride,
        discount: l.discount,
        subtotal: l.subtotal,
        listPrice: l.listPrice,
        listPriceDiscount: l.listPriceDiscount,
        manualDiscountShare: l.manualDiscountShare,
        taxable: l.taxable,
        taxRate: l.taxRate,
        taxAmount: l.taxAmount,
        total: lineTotal,
        notes: meta.notes,
      };
    });

    return {
      calcResult,
      quoteItemsCreateData,
    };
  }

  private async allocateNextQuoteNumber(
    tx: Prisma.TransactionClient,
    businessId: string,
  ): Promise<{ number: number; quoteNumber: string }> {
    const counterRows: any[] = await tx.$queryRaw`
      INSERT INTO "pos_quote_counters" ("businessId", "lastNumber")
      VALUES (${businessId}, 1)
      ON CONFLICT ("businessId")
      DO UPDATE SET "lastNumber" = "pos_quote_counters"."lastNumber" + 1
      RETURNING "lastNumber";
    `;
    const number = Number(counterRows[0]?.lastNumber || 1);
    const quoteNumber = `${QUOTE_PREFIX}-${String(number).padStart(4, '0')}`;
    return { number, quoteNumber };
  }

  async create(
    businessId: string,
    user: { sub: string; name?: string; email?: string; role: string },
    dto: CreateQuoteDto,
  ) {
    if (dto.clientRequestId) {
      const existing = await this.prisma.posQuote.findUnique({
        where: {
          businessId_clientRequestId: {
            businessId,
            clientRequestId: dto.clientRequestId,
          },
        },
        include: {
          items: { orderBy: { sortOrder: 'asc' } },
        },
      });
      if (existing) {
        return this.formatQuote(existing);
      }
    }

    const now = new Date();
    const validityDays = dto.validityDays ?? DEFAULT_QUOTE_VALIDITY_DAYS;
    const expiresAt = calculateExpiresAt(validityDays, now);
    const initialStatus = dto.status === QUOTE_STATUS.SENT ? QUOTE_STATUS.SENT : QUOTE_STATUS.DRAFT;
    const createdByName = (user.name || user.email || 'Usuario').trim().substring(0, 100);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const business = await this.getBusinessContext(tx, businessId);
        const policies = await this.policiesService.get(businessId, tx);

        const customer = await this.resolveCustomerSnapshot(tx, businessId, {
          customerId: dto.customerId,
          customerName: dto.customerName,
          customerPhone: dto.customerPhone,
          customerRuc: dto.customerRuc,
          customerAddress: dto.customerAddress,
        });

        const { calcResult, quoteItemsCreateData } = await this.prepareQuoteItemsAndTotals(
          tx,
          {
            businessId,
            business,
            policies,
            userRole: user.role,
            items: dto.items,
            discountAmount: dto.discountAmount,
            approvalToken: dto.approvalToken,
          },
        );

        const { number, quoteNumber } = await this.allocateNextQuoteNumber(tx, businessId);

        const created = await tx.posQuote.create({
          data: {
            businessId,
            number,
            quoteNumber,
            status: initialStatus,
            createdById: user.sub,
            createdByName,
            customerId: customer.customerId,
            customerName: customer.customerName,
            customerPhone: customer.customerPhone,
            customerRuc: customer.customerRuc,
            customerAddress: customer.customerAddress,
            vehicleInfo: dto.vehicleInfo ? dto.vehicleInfo.trim().substring(0, 120) : null,
            validityDays,
            expiresAt,
            notes: dto.notes ? dto.notes.trim() : null,
            conditions: dto.conditions ? dto.conditions.trim() : null,
            subtotal: calcResult.subtotal,
            discountAmount: calcResult.discountAmount,
            listPriceTotal: calcResult.listPriceTotal,
            listDiscountTotal: calcResult.listDiscountTotal,
            taxModel: calcResult.taxModel,
            taxRate: calcResult.taxRate,
            taxEnabled: calcResult.taxEnabled,
            taxIncluded: calcResult.taxIncluded,
            taxAmount: calcResult.taxAmount,
            total: calcResult.total,
            currency: business.currency || QUOTE_CURRENCY,
            sentAt: initialStatus === QUOTE_STATUS.SENT ? now : null,
            clientRequestId: dto.clientRequestId || null,
            items: {
              create: quoteItemsCreateData,
            },
          },
          include: {
            items: { orderBy: { sortOrder: 'asc' } },
          },
        });

        this.logger.log(
          `[create] Proforma ${quoteNumber} (${initialStatus}) total=${calcResult.total.toFixed(2)} negocio=${businessId}`,
        );
        return this.formatQuote(created);
      });
    } catch (err: any) {
      if (err?.code === 'P2002' && dto.clientRequestId) {
        const existing = await this.prisma.posQuote.findUnique({
          where: {
            businessId_clientRequestId: {
              businessId,
              clientRequestId: dto.clientRequestId,
            },
          },
          include: { items: { orderBy: { sortOrder: 'asc' } } },
        });
        if (existing) {
          return this.formatQuote(existing);
        }
      }
      throw err;
    }
  }

  async findAll(
    businessId: string,
    user: { sub: string; role: string },
    query: ListQuotesQueryDto,
  ) {
    await this.sweepExpiredQuotes(businessId);

    const where: any = { businessId };

    if (user.role === UserRole.VENDEDOR) {
      where.createdById = user.sub;
    }

    if (query.status) {
      const targetStatus = query.status.trim().toUpperCase();
      where.status = targetStatus;
    }

    if (query.customerId) {
      where.customerId = query.customerId.trim();
    }

    if (query.from || query.to) {
      where.createdAt = buildBusinessDateRange(query.from, query.to);
    }

    if (query.q && query.q.trim()) {
      const search = query.q.trim();
      where.OR = [
        { quoteNumber: { contains: search, mode: 'insensitive' } },
        { customerName: { contains: search, mode: 'insensitive' } },
        { customerPhone: { contains: search, mode: 'insensitive' } },
        { customerRuc: { contains: search, mode: 'insensitive' } },
        { vehicleInfo: { contains: search, mode: 'insensitive' } },
      ];
    }

    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 100) : 20;
    const skip = (page - 1) * limit;

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.posQuote.count({ where }),
      this.prisma.posQuote.findMany({
        where,
        include: {
          _count: { select: { items: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { number: 'desc' }],
        take: limit,
        skip,
      }),
    ]);

    return {
      data: rows.map((row) => this.formatQuote(row)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(
    businessId: string,
    id: string,
    user: { sub: string; role: string },
  ) {
    await this.sweepExpiredQuotes(businessId);

    const [quote, business, settings] = await Promise.all([
      this.prisma.posQuote.findFirst({
        where: { id, businessId },
        include: {
          items: { orderBy: { sortOrder: 'asc' } },
        },
      }),
      this.prisma.business.findUnique({
        where: { id: businessId },
        select: {
          id: true,
          name: true,
          taxId: true,
          posAddress: true,
          posPhone: true,
          whatsappNumber: true,
          posFooter: true,
          logoUrl: true,
        },
      }),
      this.prisma.posReceiptSettings.findUnique({
        where: { businessId },
      }),
    ]);

    if (!quote) {
      throw new NotFoundException({
        statusCode: 404,
        code: QUOTE_ERROR_CODES.QUOTE_NOT_FOUND,
        message: 'Proforma no encontrada',
      });
    }

    if (user.role === UserRole.VENDEDOR && quote.createdById !== user.sub) {
      throw new ForbiddenException({
        statusCode: 403,
        code: QUOTE_ERROR_CODES.QUOTE_FORBIDDEN,
        message: 'Los vendedores solo pueden consultar sus propias proformas',
      });
    }

    const issuer = business ? this.buildIssuerBlock(business, settings) : null;
    return this.formatQuote(quote, issuer);
  }

  async update(
    businessId: string,
    id: string,
    user: { sub: string; role: string },
    dto: UpdateQuoteDto,
  ) {
    await this.sweepExpiredQuotes(businessId);

    return this.prisma.$transaction(async (tx) => {
      const rows: any[] = await tx.$queryRaw`
        SELECT * FROM "pos_quotes"
        WHERE "id" = ${id} AND "businessId" = ${businessId}
        FOR UPDATE;
      `;
      const existing = rows[0];
      if (!existing) {
        throw new NotFoundException({
          statusCode: 404,
          code: QUOTE_ERROR_CODES.QUOTE_NOT_FOUND,
          message: 'Proforma no encontrada',
        });
      }

      const isPrivileged =
        user.role === UserRole.ENCARGADO || user.role === UserRole.SUPERADMIN;
      if (!isPrivileged && existing.createdById !== user.sub) {
        throw new ForbiddenException({
          statusCode: 403,
          code: QUOTE_ERROR_CODES.QUOTE_FORBIDDEN,
          message: 'Solo el creador o un encargado puede editar esta proforma',
        });
      }

      if (existing.status === QUOTE_STATUS.EXPIRED) {
        throw new ConflictException({
          statusCode: 409,
          code: QUOTE_ERROR_CODES.QUOTE_EXPIRED,
          message: 'La proforma está vencida y no puede editarse',
        });
      }

      if (existing.status !== QUOTE_STATUS.DRAFT) {
        throw new ConflictException({
          statusCode: 409,
          code: QUOTE_ERROR_CODES.QUOTE_NOT_EDITABLE,
          message: 'Solo se pueden editar proformas en estado borrador (DRAFT)',
        });
      }

      const existingItems = await tx.posQuoteItem.findMany({
        where: { quoteId: id },
        orderBy: { sortOrder: 'asc' },
      });

      const itemsInput: CreateQuoteItemDto[] = dto.items
        ? dto.items
        : existingItems.map((it) => ({
            productId: it.productId,
            productName: it.productName,
            unit: it.unit,
            quantity: Number(it.quantity),
            unitPrice: it.unitPrice,
            discount: it.discount,
            taxable: it.taxable,
            notes: it.notes,
          }));

      const business = await this.getBusinessContext(tx, businessId);
      const policies = await this.policiesService.get(businessId, tx);

      const hasCustomerField =
        dto.customerId !== undefined ||
        dto.customerName !== undefined ||
        dto.customerPhone !== undefined ||
        dto.customerRuc !== undefined ||
        dto.customerAddress !== undefined;

      const customer = hasCustomerField
        ? await this.resolveCustomerSnapshot(tx, businessId, {
            customerId:
              dto.customerId !== undefined ? dto.customerId : existing.customerId,
            customerName:
              dto.customerName !== undefined ? dto.customerName : existing.customerName,
            customerPhone:
              dto.customerPhone !== undefined
                ? dto.customerPhone
                : existing.customerPhone,
            customerRuc:
              dto.customerRuc !== undefined ? dto.customerRuc : existing.customerRuc,
            customerAddress:
              dto.customerAddress !== undefined
                ? dto.customerAddress
                : existing.customerAddress,
          })
        : {
            customerId: existing.customerId,
            customerName: existing.customerName,
            customerPhone: existing.customerPhone,
            customerRuc: existing.customerRuc,
            customerAddress: existing.customerAddress,
          };

      const targetDiscount =
        dto.discountAmount !== undefined
          ? dto.discountAmount
          : Number(existing.discountAmount || 0);

      const { calcResult, quoteItemsCreateData } =
        await this.prepareQuoteItemsAndTotals(tx, {
          businessId,
          business,
          policies,
          userRole: user.role,
          items: itemsInput,
          discountAmount: targetDiscount,
          approvalToken: dto.approvalToken,
        });

      const validityDays =
        dto.validityDays !== undefined ? dto.validityDays : existing.validityDays;
      const expiresAt =
        dto.validityDays !== undefined
          ? calculateExpiresAt(validityDays, new Date())
          : existing.expiresAt;

      await tx.posQuoteItem.deleteMany({ where: { quoteId: id } });

      const updated = await tx.posQuote.update({
        where: { id },
        data: {
          customerId: customer.customerId,
          customerName: customer.customerName,
          customerPhone: customer.customerPhone,
          customerRuc: customer.customerRuc,
          customerAddress: customer.customerAddress,
          vehicleInfo:
            dto.vehicleInfo !== undefined
              ? dto.vehicleInfo
                ? dto.vehicleInfo.trim().substring(0, 120)
                : null
              : existing.vehicleInfo,
          validityDays,
          expiresAt,
          notes:
            dto.notes !== undefined
              ? dto.notes
                ? dto.notes.trim()
                : null
              : existing.notes,
          conditions:
            dto.conditions !== undefined
              ? dto.conditions
                ? dto.conditions.trim()
                : null
              : existing.conditions,
          subtotal: calcResult.subtotal,
          discountAmount: calcResult.discountAmount,
          listPriceTotal: calcResult.listPriceTotal,
          listDiscountTotal: calcResult.listDiscountTotal,
          taxModel: calcResult.taxModel,
          taxRate: calcResult.taxRate,
          taxEnabled: calcResult.taxEnabled,
          taxIncluded: calcResult.taxIncluded,
          taxAmount: calcResult.taxAmount,
          total: calcResult.total,
          items: {
            create: quoteItemsCreateData,
          },
        },
        include: {
          items: { orderBy: { sortOrder: 'asc' } },
        },
      });

      return this.formatQuote(updated);
    });
  }

  async updateStatus(
    businessId: string,
    id: string,
    user: { sub: string; role: string },
    dto: UpdateQuoteStatusDto,
  ) {
    await this.sweepExpiredQuotes(businessId);

    return this.prisma.$transaction(async (tx) => {
      const rows: any[] = await tx.$queryRaw`
        SELECT * FROM "pos_quotes"
        WHERE "id" = ${id} AND "businessId" = ${businessId}
        FOR UPDATE;
      `;
      const existing = rows[0];
      if (!existing) {
        throw new NotFoundException({
          statusCode: 404,
          code: QUOTE_ERROR_CODES.QUOTE_NOT_FOUND,
          message: 'Proforma no encontrada',
        });
      }

      if (existing.status === QUOTE_STATUS.CONVERTED) {
        throw new ConflictException({
          statusCode: 409,
          code: QUOTE_ERROR_CODES.QUOTE_ALREADY_CONVERTED,
          message: 'Esta proforma ya fue convertida en una venta',
        });
      }

      if (existing.status === QUOTE_STATUS.CANCELLED) {
        throw new ConflictException({
          statusCode: 409,
          code: QUOTE_ERROR_CODES.QUOTE_CANCELLED,
          message: 'La proforma ya está cancelada',
        });
      }

      if (existing.status === QUOTE_STATUS.EXPIRED) {
        throw new ConflictException({
          statusCode: 409,
          code: QUOTE_ERROR_CODES.QUOTE_EXPIRED,
          message: 'La proforma está vencida y no admite cambios de estado',
        });
      }

      const isPrivileged =
        user.role === UserRole.ENCARGADO || user.role === UserRole.SUPERADMIN;
      const now = new Date();
      const target = dto.status;

      if (target === QUOTE_STATUS.SENT) {
        if (existing.status !== QUOTE_STATUS.DRAFT) {
          throw new ConflictException({
            statusCode: 409,
            code: QUOTE_ERROR_CODES.INVALID_STATUS_TRANSITION,
            message: `Solo una proforma en borrador puede emitirse (estado actual: ${existing.status})`,
          });
        }
        if (!isPrivileged && existing.createdById !== user.sub) {
          throw new ForbiddenException({
            statusCode: 403,
            code: QUOTE_ERROR_CODES.QUOTE_FORBIDDEN,
            message: 'Solo el creador o un encargado puede emitir esta proforma',
          });
        }

        const updated = await tx.posQuote.update({
          where: { id },
          data: { status: QUOTE_STATUS.SENT, sentAt: now },
          include: { items: { orderBy: { sortOrder: 'asc' } } },
        });
        return this.formatQuote(updated);
      }

      if (target === QUOTE_STATUS.ACCEPTED) {
        if (existing.status !== QUOTE_STATUS.SENT) {
          throw new ConflictException({
            statusCode: 409,
            code: QUOTE_ERROR_CODES.INVALID_STATUS_TRANSITION,
            message: `Solo una proforma emitida (SENT) puede marcarse como aceptada (estado actual: ${existing.status})`,
          });
        }
        if (user.role === UserRole.VENDEDOR && existing.createdById !== user.sub) {
          throw new ForbiddenException({
            statusCode: 403,
            code: QUOTE_ERROR_CODES.QUOTE_FORBIDDEN,
            message: 'Los vendedores solo pueden marcar como aceptadas sus propias proformas',
          });
        }

        const updated = await tx.posQuote.update({
          where: { id },
          data: { status: QUOTE_STATUS.ACCEPTED, acceptedAt: now },
          include: { items: { orderBy: { sortOrder: 'asc' } } },
        });
        return this.formatQuote(updated);
      }

      if (target === QUOTE_STATUS.CANCELLED) {
        if (
          ![QUOTE_STATUS.DRAFT, QUOTE_STATUS.SENT, QUOTE_STATUS.ACCEPTED].includes(
            existing.status,
          )
        ) {
          throw new ConflictException({
            statusCode: 409,
            code: QUOTE_ERROR_CODES.INVALID_STATUS_TRANSITION,
            message: `No se puede cancelar una proforma en estado ${existing.status}`,
          });
        }
        if (!isPrivileged && existing.createdById !== user.sub) {
          throw new ForbiddenException({
            statusCode: 403,
            code: QUOTE_ERROR_CODES.QUOTE_FORBIDDEN,
            message: 'Solo puedes cancelar tus propias proformas',
          });
        }

        const reason = (dto.cancelReason || '').trim();
        if (!reason) {
          throw new BadRequestException({
            statusCode: 400,
            code: QUOTE_ERROR_CODES.CANCEL_REASON_REQUIRED,
            message: 'El motivo de cancelación es obligatorio',
          });
        }

        const updated = await tx.posQuote.update({
          where: { id },
          data: {
            status: QUOTE_STATUS.CANCELLED,
            cancelledAt: now,
            cancelledById: user.sub,
            cancelReason: reason.substring(0, 500),
          },
          include: { items: { orderBy: { sortOrder: 'asc' } } },
        });
        return this.formatQuote(updated);
      }

      throw new ConflictException({
        statusCode: 409,
        code: QUOTE_ERROR_CODES.INVALID_STATUS_TRANSITION,
        message: 'Transición de estado no permitida',
      });
    });
  }

  async duplicate(
    businessId: string,
    id: string,
    user: { sub: string; name?: string; email?: string; role: string },
    dto: DuplicateQuoteDto = {},
  ) {
    await this.sweepExpiredQuotes(businessId);

    const original = await this.prisma.posQuote.findFirst({
      where: { id, businessId },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });

    if (!original) {
      throw new NotFoundException({
        statusCode: 404,
        code: QUOTE_ERROR_CODES.QUOTE_NOT_FOUND,
        message: 'Proforma no encontrada',
      });
    }

    if (user.role === UserRole.VENDEDOR && original.createdById !== user.sub) {
      throw new ForbiddenException({
        statusCode: 403,
        code: QUOTE_ERROR_CODES.QUOTE_FORBIDDEN,
        message: 'Los vendedores solo pueden duplicar sus propias proformas',
      });
    }

    if (dto.clientRequestId) {
      const existingDup = await this.prisma.posQuote.findUnique({
        where: {
          businessId_clientRequestId: {
            businessId,
            clientRequestId: dto.clientRequestId,
          },
        },
        include: { items: { orderBy: { sortOrder: 'asc' } } },
      });
      if (existingDup) {
        return this.formatQuote(existingDup);
      }
    }

    const now = new Date();
    const validityDays =
      dto.validityDays ?? original.validityDays ?? DEFAULT_QUOTE_VALIDITY_DAYS;
    const expiresAt = calculateExpiresAt(validityDays, now);
    const createdByName = (user.name || user.email || 'Usuario').trim().substring(0, 100);

    // En catálogo omitimos unitPrice para que tome precios vigentes; líneas libres conservan precio
    const itemsForDuplicate: CreateQuoteItemDto[] = original.items.map((it) => ({
      productId: it.productId,
      productName: it.productName,
      unit: it.unit,
      quantity: Number(it.quantity),
      unitPrice: it.productId ? undefined : it.unitPrice,
      discount: it.discount,
      taxable: it.taxable,
      notes: it.notes,
    }));

    return this.prisma.$transaction(async (tx) => {
      const business = await this.getBusinessContext(tx, businessId);
      const policies = await this.policiesService.get(businessId, tx);

      const { calcResult, quoteItemsCreateData } =
        await this.prepareQuoteItemsAndTotals(tx, {
          businessId,
          business,
          policies,
          userRole: user.role,
          items: itemsForDuplicate,
          discountAmount: Number(original.discountAmount || 0),
          missingProductStatus: 'UNPROCESSABLE',
        });

      const { number, quoteNumber } = await this.allocateNextQuoteNumber(tx, businessId);

      const created = await tx.posQuote.create({
        data: {
          businessId,
          number,
          quoteNumber,
          status: QUOTE_STATUS.DRAFT,
          createdById: user.sub,
          createdByName,
          customerId: original.customerId,
          customerName: original.customerName,
          customerPhone: original.customerPhone,
          customerRuc: original.customerRuc,
          customerAddress: original.customerAddress,
          vehicleInfo: original.vehicleInfo,
          validityDays,
          expiresAt,
          notes: original.notes,
          conditions: original.conditions,
          subtotal: calcResult.subtotal,
          discountAmount: calcResult.discountAmount,
          listPriceTotal: calcResult.listPriceTotal,
          listDiscountTotal: calcResult.listDiscountTotal,
          taxModel: calcResult.taxModel,
          taxRate: calcResult.taxRate,
          taxEnabled: calcResult.taxEnabled,
          taxIncluded: calcResult.taxIncluded,
          taxAmount: calcResult.taxAmount,
          total: calcResult.total,
          currency: business.currency || QUOTE_CURRENCY,
          clientRequestId: dto.clientRequestId || null,
          items: {
            create: quoteItemsCreateData,
          },
        },
        include: {
          items: { orderBy: { sortOrder: 'asc' } },
        },
      });

      this.logger.log(
        `[duplicate] ${original.quoteNumber} -> ${quoteNumber} negocio=${businessId}`,
      );
      return this.formatQuote(created);
    });
  }

  async prepareConversion(
    businessId: string,
    id: string,
    user: { sub: string; role: string },
  ) {
    await this.sweepExpiredQuotes(businessId);

    const [quote, business] = await Promise.all([
      this.prisma.posQuote.findFirst({
        where: { id, businessId },
        include: {
          items: { orderBy: { sortOrder: 'asc' } },
        },
      }),
      this.prisma.business.findUnique({
        where: { id: businessId },
        select: {
          id: true,
          wholesaleEnabled: true,
          tracksBatches: true,
          useListPrice: true,
          taxEnabled: true,
          taxIncluded: true,
          taxRate: true,
          currency: true,
        },
      }),
    ]);

    if (!quote) {
      throw new NotFoundException({
        statusCode: 404,
        code: QUOTE_ERROR_CODES.QUOTE_NOT_FOUND,
        message: 'Proforma no encontrada',
      });
    }

    if (quote.status === QUOTE_STATUS.CONVERTED) {
      throw new ConflictException({
        statusCode: 409,
        code: QUOTE_ERROR_CODES.QUOTE_ALREADY_CONVERTED,
        message: 'Esta proforma ya fue convertida en una venta',
      });
    }

    if (quote.status === QUOTE_STATUS.CANCELLED) {
      throw new ConflictException({
        statusCode: 409,
        code: QUOTE_ERROR_CODES.QUOTE_CANCELLED,
        message: 'No se puede convertir una proforma cancelada',
      });
    }

    if (quote.status === QUOTE_STATUS.DRAFT) {
      throw new ConflictException({
        statusCode: 409,
        code: QUOTE_ERROR_CODES.QUOTE_NOT_SENT,
        message: 'La proforma debe emitirse antes de convertirse en venta',
      });
    }

    const isExpired = quote.status === QUOTE_STATUS.EXPIRED;
    const isPrivileged =
      user.role === UserRole.ENCARGADO || user.role === UserRole.SUPERADMIN;

    if (isExpired && !isPrivileged) {
      throw new ForbiddenException({
        statusCode: 403,
        code: QUOTE_ERROR_CODES.QUOTE_EXPIRED,
        message:
          'La proforma está vencida. Solo un encargado puede convertir una proforma vencida.',
      });
    }

    const catalogIds = Array.from(
      new Set(
        quote.items
          .map((it) => it.productId)
          .filter((pid): pid is string => Boolean(pid)),
      ),
    );

    const products = catalogIds.length
      ? await this.prisma.product.findMany({
          where: { id: { in: catalogIds }, businessId },
          include: {
            recipeComponents: {
              include: { componentProduct: true },
            },
          },
        })
      : [];
    const productMap = new Map(products.map((p) => [p.id, p]));

    let hasPriceChanges = false;
    let hasInsufficientStock = false;
    let hasMissingProducts = false;

    const preparedItems = quote.items.map((item) => {
      const qty = Number(item.quantity);
      const quotedUnitPrice = round2(item.unitPrice);

      if (!item.productId) {
        return {
          quoteItemId: item.id,
          sortOrder: item.sortOrder,
          productId: null,
          productName: item.productName,
          barcode: null,
          unit: item.unit || 'UND',
          itemType: 'CUSTOM',
          quantity: qty,
          taxable: Boolean(item.taxable),
          quotedUnitPrice,
          currentUnitPrice: quotedUnitPrice,
          recommendedUnitPrice: quotedUnitPrice,
          priceChanged: false,
          priceDiff: 0,
          productExists: true,
          productActive: true,
          availableStock: null as number | null,
          hasSufficientStock: true,
          requiresBatches: false,
        };
      }

      const product = productMap.get(item.productId);
      if (!product || !product.isActive) {
        hasMissingProducts = true;
        hasInsufficientStock = true;
        return {
          quoteItemId: item.id,
          sortOrder: item.sortOrder,
          productId: item.productId,
          productName: item.productName,
          barcode: item.barcode || null,
          unit: item.unit || 'UND',
          itemType: item.itemType || 'PRODUCT',
          quantity: qty,
          taxable: Boolean(item.taxable),
          quotedUnitPrice,
          currentUnitPrice: null as number | null,
          recommendedUnitPrice: null as number | null,
          priceChanged: false,
          priceDiff: null as number | null,
          productExists: Boolean(product),
          productActive: Boolean(product?.isActive),
          availableStock: 0,
          hasSufficientStock: false,
          requiresBatches: false,
        };
      }

      const resolvedCurrent = resolveLineUnitPrice(product, qty, business);
      const currentUnitPrice = round2(resolvedCurrent.unitPrice);
      const priceDiff = round2(currentUnitPrice - quotedUnitPrice);
      const priceChanged = Math.abs(priceDiff) > 0.01;
      if (priceChanged) hasPriceChanges = true;

      const recommendedUnitPrice = isExpired ? currentUnitPrice : quotedUnitPrice;

      let availableStock: number | null = null;
      let hasSufficientStock = true;
      let requiresBatches = this.batchesService.isTracked(business, product);

      if (product.isRecipe && product.recipeComponents?.length > 0) {
        let minMakeable: number | null = null;
        for (const comp of product.recipeComponents) {
          const compProd = comp.componentProduct;
          if (!compProd) continue;
          if (this.batchesService.isTracked(business, compProd)) {
            requiresBatches = true;
          }
          if (compProd.trackStock) {
            const compAvail =
              Number(compProd.stock) - Number(compProd.reservedStock || 0);
            const compQty = Number(comp.quantity);
            const makeable = compQty > 0 ? round3(compAvail / compQty) : 0;
            minMakeable =
              minMakeable === null ? makeable : Math.min(minMakeable, makeable);
          }
        }
        availableStock = minMakeable;
        if (availableStock !== null) {
          hasSufficientStock = availableStock >= qty;
        }
      } else if (product.trackStock) {
        availableStock = round3(
          Number(product.stock) - Number(product.reservedStock || 0),
        );
        hasSufficientStock = availableStock >= qty;
      }

      if (!hasSufficientStock) hasInsufficientStock = true;

      return {
        quoteItemId: item.id,
        sortOrder: item.sortOrder,
        productId: product.id,
        productName: product.name,
        barcode: product.barcode || null,
        unit: product.unit || item.unit || 'UND',
        itemType: product.type === 'SERVICE' ? 'SERVICE' : 'PRODUCT',
        quantity: qty,
        taxable: Boolean(product.taxable),
        quotedUnitPrice,
        currentUnitPrice,
        recommendedUnitPrice,
        priceChanged,
        priceDiff,
        productExists: true,
        productActive: true,
        availableStock,
        hasSufficientStock,
        requiresBatches,
      };
    });

    return {
      quoteId: quote.id,
      quoteNumber: quote.quoteNumber,
      status: quote.status,
      isExpired,
      priceProtectionApplied: !isExpired,
      useCurrentPrices: isExpired,
      currency: business?.currency || quote.currency || QUOTE_CURRENCY,
      expiresAt: quote.expiresAt,
      validUntilLabel: formatDateDdMmYyyy(quote.expiresAt),
      customerId: quote.customerId || null,
      customerName: quote.customerName || null,
      customerPhone: quote.customerPhone || null,
      customerRuc: quote.customerRuc || null,
      customerAddress: quote.customerAddress || null,
      vehicleInfo: quote.vehicleInfo || null,
      discountAmount: round2(quote.discountAmount || 0),
      quotedTotal: round2(quote.total),
      hasPriceChanges,
      hasInsufficientStock,
      hasMissingProducts,
      items: preparedItems,
    };
  }
}

