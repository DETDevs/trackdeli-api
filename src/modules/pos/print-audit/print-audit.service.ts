import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as sharp from 'sharp';
import sanitizeHtml from 'sanitize-html';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreatePrintEventDto } from './dto/create-print-event.dto';
import { UpdateReceiptSettingsDto } from './dto/update-receipt-settings.dto';

/**
 * Enmascara números de teléfono en reason para no guardar teléfonos completos (máx últimos 4 dígitos).
 */
function maskPhoneInReason(reason?: string | null): string | null {
  if (!reason) return reason ?? null;
  return reason.replace(/(\+?\d[\d\s\-()]{5,}\d)/g, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length >= 7) {
      const last4 = digits.slice(-4);
      return `***${last4}`;
    }
    return match;
  });
}

@Injectable()
export class PrintAuditService {
  private readonly logger = new Logger(PrintAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Valida que un documento pertenezca al negocio especificado.
   */
  async validateDocumentOwnership(
    businessId: string,
    documentType: string,
    documentId: string,
  ): Promise<boolean> {
    switch (documentType) {
      case 'SALE':
        return !!(await this.prisma.sale.findFirst({
          where: { id: documentId, businessId },
          select: { id: true },
        }));
      case 'TABLE_ORDER':
        return !!(await this.prisma.tableOrder.findFirst({
          where: { id: documentId, businessId },
          select: { id: true },
        }));
      case 'PURCHASE':
        return !!(await this.prisma.purchase.findFirst({
          where: { id: documentId, businessId },
          select: { id: true },
        }));
      case 'CASH_CLOSE':
        return !!(await this.prisma.cashRegister.findFirst({
          where: { id: documentId, businessId },
          select: { id: true },
        }));
      case 'CREDIT_PAYMENT':
        return !!(await this.prisma.creditPayment.findFirst({
          where: { id: documentId, creditAccount: { businessId } },
          select: { id: true },
        }));
      case 'EXPENSE':
        return !!(await this.prisma.expense.findFirst({
          where: { id: documentId, businessId },
          select: { id: true },
        }));
      case 'SUPPLIER_PAYMENT':
        return !!(await this.prisma.supplierPayment.findFirst({
          where: { id: documentId, payableAccount: { businessId } },
          select: { id: true },
        }));
      case 'SALE_RETURN':
        return !!(await this.prisma.saleReturn.findFirst({
          where: { id: documentId, businessId },
          select: { id: true },
        }));
      default:
        return false;
    }
  }

  /**
   * Registra un lote de eventos de impresión / compartir de forma idempotente.
   */
  async registerEvents(
    businessId: string,
    userId: string,
    rawEvents: CreatePrintEventDto[],
  ) {
    if (!Array.isArray(rawEvents)) {
      throw new BadRequestException('El cuerpo debe ser una lista de eventos o contener events: []');
    }

    if (rawEvents.length > 200) {
      throw new BadRequestException('El lote no puede exceder 200 eventos');
    }

    if (rawEvents.length === 0) {
      return [];
    }

    const now = Date.now();
    // Validar precondiciones de cada evento
    for (const ev of rawEvents) {
      if (!ev.clientEventId || !ev.documentType || !ev.documentId || !ev.eventType || !ev.status) {
        throw new BadRequestException('Faltan campos obligatorios en uno o más eventos');
      }

      const occurredAtDate = new Date(ev.occurredAt);
      if (isNaN(occurredAtDate.getTime())) {
        throw new BadRequestException(`Fecha occurredAt inválida en evento ${ev.clientEventId}`);
      }

      // Rechazar fechas absurdas en el futuro lejano (> 10 min por skew de reloj)
      if (occurredAtDate.getTime() > now + 10 * 60 * 1000) {
        throw new BadRequestException(
          `La fecha occurredAt del evento ${ev.clientEventId} no puede estar en el futuro`,
        );
      }

      if (ev.reason && ev.reason.length > 300) {
        throw new BadRequestException(
          `El motivo (reason) del evento ${ev.clientEventId} no puede exceder 300 caracteres`,
        );
      }

      const belongsToBusiness = await this.validateDocumentOwnership(
        businessId,
        ev.documentType,
        ev.documentId,
      );
      if (!belongsToBusiness) {
        throw new BadRequestException(
          `El documento ${ev.documentType} con id ${ev.documentId} no existe o no pertenece al negocio`,
        );
      }
    }

    // Procesar secuencialmente en transacción para calcular sequence e isReprint de forma consistente
    return this.prisma.$transaction(async (tx) => {
      const results: any[] = [];

      for (const ev of rawEvents) {
        // Idempotencia: si ya existe por (businessId, clientEventId), no duplicar
        const existing = await tx.posPrintEvent.findUnique({
          where: {
            businessId_clientEventId: { businessId, clientEventId: ev.clientEventId },
          },
        });

        if (existing) {
          results.push({
            clientEventId: existing.clientEventId,
            id: existing.id,
            sequence: existing.sequence,
            isReprint: existing.isReprint,
            status: existing.status,
            eventType: existing.eventType,
          });
          continue;
        }

        let sequence = 1;
        let isReprint = false;

        if (ev.eventType === 'PRINT') {
          const prevOkPrints = await tx.posPrintEvent.count({
            where: {
              businessId,
              documentType: ev.documentType,
              documentId: ev.documentId,
              eventType: 'PRINT',
              status: 'OK',
            },
          });

          if (ev.status === 'OK') {
            sequence = prevOkPrints + 1;
            isReprint = prevOkPrints > 0;
          } else {
            sequence = prevOkPrints;
            isReprint = false;
          }
        } else {
          const prevOkCount = await tx.posPrintEvent.count({
            where: {
              businessId,
              documentType: ev.documentType,
              documentId: ev.documentId,
              eventType: ev.eventType,
              status: 'OK',
            },
          });

          if (ev.status === 'OK') {
            sequence = prevOkCount + 1;
            isReprint = false;
          } else {
            sequence = prevOkCount;
            isReprint = false;
          }
        }

        const created = await tx.posPrintEvent.create({
          data: {
            businessId,
            documentType: ev.documentType,
            documentId: ev.documentId,
            eventType: ev.eventType,
            copies: ev.copies || [],
            status: ev.status,
            sequence,
            isReprint,
            userId, // SIEMPRE el del token
            deviceId: ev.deviceId ?? null,
            stationName: ev.stationName ?? null,
            cashRegisterId: ev.cashRegisterId ?? null,
            reason: maskPhoneInReason(ev.reason),
            clientEventId: ev.clientEventId,
            occurredAt: new Date(ev.occurredAt),
          },
        });

        results.push({
          clientEventId: created.clientEventId,
          id: created.id,
          sequence: created.sequence,
          isReprint: created.isReprint,
          status: created.status,
          eventType: created.eventType,
        });
      }

      return results;
    });
  }

  /**
   * Obtiene la auditoría de un documento específico.
   */
  async getDocumentAudit(businessId: string, documentType: string, documentId: string) {
    const belongs = await this.validateDocumentOwnership(businessId, documentType, documentId);
    if (!belongs) {
      throw new NotFoundException('Documento no encontrado o no pertenece al negocio');
    }

    const events = await this.prisma.posPrintEvent.findMany({
      where: {
        businessId,
        documentType,
        documentId,
      },
      include: {
        user: { select: { id: true, name: true } },
      },
      orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
    });

    const okPrintEvents = events.filter((e) => e.eventType === 'PRINT' && e.status === 'OK');
    const okShareEvents = events.filter((e) => e.eventType === 'SHARE' && e.status === 'OK');

    const printCount = okPrintEvents.length;
    const reprintCount = okPrintEvents.filter((e) => e.isReprint).length;
    const shareCount = okShareEvents.length;
    const firstPrintedAt = okPrintEvents.length > 0 ? okPrintEvents[0].occurredAt : null;
    const lastPrintedAt =
      okPrintEvents.length > 0 ? okPrintEvents[okPrintEvents.length - 1].occurredAt : null;

    return {
      printCount,
      reprintCount,
      shareCount,
      firstPrintedAt,
      lastPrintedAt,
      events: events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        copies: e.copies,
        status: e.status,
        isReprint: e.isReprint,
        sequence: e.sequence,
        user: {
          id: e.user?.id || e.userId,
          name: e.user?.name || 'Usuario',
        },
        stationName: e.stationName,
        reason: e.reason,
        occurredAt: e.occurredAt,
      })),
    };
  }

  /**
   * Obtiene mapa id -> { printCount, shareCount, lastPrintedAt } para hasta 200 documentos.
   */
  async getCounts(businessId: string, documentType: string, ids: string[]) {
    const map: Record<
      string,
      { printCount: number; shareCount: number; lastPrintedAt: Date | null }
    > = {};

    for (const id of ids) {
      map[id] = { printCount: 0, shareCount: 0, lastPrintedAt: null };
    }

    if (ids.length === 0) {
      return map;
    }

    const events = await this.prisma.posPrintEvent.findMany({
      where: {
        businessId,
        documentType,
        documentId: { in: ids },
        status: 'OK',
      },
      select: {
        documentId: true,
        eventType: true,
        occurredAt: true,
      },
      orderBy: { occurredAt: 'asc' },
    });

    for (const ev of events) {
      const entry = map[ev.documentId];
      if (!entry) continue;

      if (ev.eventType === 'PRINT') {
        entry.printCount += 1;
        if (!entry.lastPrintedAt || ev.occurredAt > entry.lastPrintedAt) {
          entry.lastPrintedAt = ev.occurredAt;
        }
      } else if (ev.eventType === 'SHARE') {
        entry.shareCount += 1;
      }
    }

    return map;
  }

  /**
   * Resuelve el rango de fechas en zona horaria America/Managua (-06:00).
   */
  resolveDateRange(period?: string, from?: string, to?: string) {
    const MANAGUA_OFFSET_MS = -6 * 60 * 60 * 1000;

    const createUtcDateFromManagua = (
      year: number,
      month: number,
      day: number,
      hour = 0,
      minute = 0,
      second = 0,
      ms = 0,
    ) => {
      return new Date(Date.UTC(year, month, day, hour + 6, minute, second, ms));
    };

    const nowUtc = new Date();
    const nowManagua = new Date(nowUtc.getTime() + MANAGUA_OFFSET_MS);
    const y = nowManagua.getUTCFullYear();
    const m = nowManagua.getUTCMonth();
    const d = nowManagua.getUTCDate();

    let curFrom: Date;
    let curTo: Date;

    const cleanFrom = from?.trim();
    const cleanTo = to?.trim();

    if (cleanFrom || cleanTo) {
      if (!cleanFrom || !cleanTo) {
        throw new BadRequestException(
          'Se requieren ambos parámetros (from y to) para un rango personalizado',
        );
      }

      if (cleanFrom.includes('T')) {
        curFrom = new Date(cleanFrom);
      } else {
        const parts = cleanFrom.split('-').map(Number);
        if (parts.length !== 3 || parts.some(isNaN)) {
          throw new BadRequestException('Formato de fecha inválido en from (esperado YYYY-MM-DD)');
        }
        curFrom = createUtcDateFromManagua(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
      }

      if (cleanTo.includes('T')) {
        curTo = new Date(cleanTo);
      } else {
        const parts = cleanTo.split('-').map(Number);
        if (parts.length !== 3 || parts.some(isNaN)) {
          throw new BadRequestException('Formato de fecha inválido en to (esperado YYYY-MM-DD)');
        }
        curTo = createUtcDateFromManagua(parts[0], parts[1] - 1, parts[2], 23, 59, 59, 999);
      }

      if (isNaN(curFrom.getTime()) || isNaN(curTo.getTime())) {
        throw new BadRequestException('Formato de fecha inválido');
      }

      if (curFrom > curTo) {
        throw new BadRequestException(
          'La fecha inicial (from) no puede ser posterior a la fecha final (to)',
        );
      }

      const diffMs = curTo.getTime() - curFrom.getTime();
      if (diffMs > 366 * 24 * 60 * 60 * 1000) {
        throw new BadRequestException('El rango de fechas no puede exceder 366 días');
      }
    } else if (period === 'week') {
      const dayOfWeek = nowManagua.getUTCDay();
      const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      curFrom = createUtcDateFromManagua(y, m, d + diffToMonday, 0, 0, 0, 0);
      curTo = createUtcDateFromManagua(y, m, d + diffToMonday + 6, 23, 59, 59, 999);
    } else if (period === 'month') {
      curFrom = createUtcDateFromManagua(y, m, 1, 0, 0, 0, 0);
      const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      curTo = createUtcDateFromManagua(y, m, lastDay, 23, 59, 59, 999);
    } else {
      // Default: 'today'
      curFrom = createUtcDateFromManagua(y, m, d, 0, 0, 0, 0);
      curTo = createUtcDateFromManagua(y, m, d, 23, 59, 59, 999);
    }

    return { curFrom, curTo };
  }

  /**
   * Reporte consolidado de auditoría de impresiones (solo ENCARGADO / SUPERADMIN).
   */
  async getReport(
    businessId: string,
    query: {
      from?: string;
      to?: string;
      period?: string;
      documentType?: string;
      userId?: string;
      minReprints?: string | number;
    },
  ) {
    const { curFrom, curTo } = this.resolveDateRange(query.period, query.from, query.to);

    const where: any = {
      businessId,
      occurredAt: { gte: curFrom, lte: curTo },
    };

    if (query.documentType) {
      where.documentType = query.documentType;
    }
    if (query.userId) {
      where.userId = query.userId;
    }

    const events = await this.prisma.posPrintEvent.findMany({
      where,
      include: {
        user: { select: { id: true, name: true } },
      },
      orderBy: { occurredAt: 'desc' },
    });

    let printCount = 0;
    let reprintCount = 0;
    let shareCount = 0;
    let failedCount = 0;

    const userMap = new Map<
      string,
      {
        userId: string;
        userName: string;
        printCount: number;
        reprintCount: number;
        shareCount: number;
      }
    >();

    const docMap = new Map<
      string,
      {
        documentType: string;
        documentId: string;
        printCount: number;
        reprintCount: number;
        shareCount: number;
        lastPrintedAt: Date | null;
        lastPrintedBy: { id: string; name: string } | null;
      }
    >();

    for (const e of events) {
      if (e.status === 'FAILED') {
        failedCount++;
        continue;
      }

      if (e.eventType === 'PRINT') {
        printCount++;
        if (e.isReprint) {
          reprintCount++;
        }
      } else if (e.eventType === 'SHARE') {
        shareCount++;
      }

      // Conteo por usuario
      const uid = e.userId;
      const uname = e.user?.name || 'Desconocido';
      if (!userMap.has(uid)) {
        userMap.set(uid, {
          userId: uid,
          userName: uname,
          printCount: 0,
          reprintCount: 0,
          shareCount: 0,
        });
      }
      const u = userMap.get(uid)!;
      if (e.eventType === 'PRINT') {
        u.printCount++;
        if (e.isReprint) u.reprintCount++;
      } else if (e.eventType === 'SHARE') {
        u.shareCount++;
      }

      // Conteo por documento
      const docKey = `${e.documentType}:${e.documentId}`;
      if (!docMap.has(docKey)) {
        docMap.set(docKey, {
          documentType: e.documentType,
          documentId: e.documentId,
          printCount: 0,
          reprintCount: 0,
          shareCount: 0,
          lastPrintedAt: null,
          lastPrintedBy: null,
        });
      }
      const d = docMap.get(docKey)!;
      if (e.eventType === 'PRINT') {
        d.printCount++;
        if (e.isReprint) d.reprintCount++;
        if (!d.lastPrintedAt || e.occurredAt > d.lastPrintedAt) {
          d.lastPrintedAt = e.occurredAt;
          d.lastPrintedBy = e.user ? { id: e.user.id, name: e.user.name } : null;
        }
      } else if (e.eventType === 'SHARE') {
        d.shareCount++;
      }
    }

    const minRep =
      query.minReprints !== undefined && query.minReprints !== ''
        ? Math.max(0, Number(query.minReprints))
        : 1;

    const topReprintedDocuments = Array.from(docMap.values())
      .filter((d) => d.reprintCount >= minRep)
      .sort((a, b) => b.reprintCount - a.reprintCount)
      .map((d) => ({
        ...d,
        isHighlight: d.reprintCount >= 3,
      }));

    return {
      totals: {
        printCount,
        reprintCount,
        shareCount,
        failedCount,
      },
      byUser: Array.from(userMap.values()),
      topReprintedDocuments,
    };
  }

  /**
   * Obtiene la configuración de ticket del negocio.
   * Si no tiene fila, devuelve los valores por defecto que reproducen exactamente el ticket actual, sin crear fila.
   */
  async getReceiptSettings(businessId: string) {
    const settings = await this.prisma.posReceiptSettings.findUnique({
      where: { businessId },
    });

    if (settings) {
      return settings;
    }

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { posFooter: true },
    });

    return {
      id: null,
      businessId,
      logoImage: null,
      showLogo: false,
      headerLines: [],
      footerLines: business?.posFooter ? [business.posFooter] : ['¡Gracias por su compra!'],
      showBusinessName: true,
      showAddress: true,
      showPhone: true,
      showTaxId: true,
      showCashier: true,
      showCustomer: true,
      showTaxBreakdown: true,
      showBatches: false,
      paperWidthMm: 80,
      updatedAt: null,
      updatedById: null,
    };
  }

  /**
   * Actualiza o crea la configuración de ticket por negocio.
   * Valida textos (sin HTML, sin control chars, máx. 48 caracteres), ancho de papel (58 | 80),
   * y valida imágenes PNG/JPEG base64 (máx. 100 KB, máx. 576 px de ancho).
   */
  async updateReceiptSettings(
    businessId: string,
    userId: string,
    dto: UpdateReceiptSettingsDto,
  ) {
    const sanitizeLine = (line: string): string => {
      if (typeof line !== 'string') return '';
      if (line.length > 48) {
        throw new BadRequestException(
          'Cada línea de encabezado o pie de página puede tener un máximo de 48 caracteres',
        );
      }
      const strippedHtml = sanitizeHtml(line, { allowedTags: [], allowedAttributes: {} });
      const cleaned = strippedHtml.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
      if (cleaned.length > 48) {
        throw new BadRequestException(
          'Cada línea de encabezado o pie de página puede tener un máximo de 48 caracteres',
        );
      }
      return cleaned;
    };

    let sanitizedHeaderLines: string[] | undefined = undefined;
    if (dto.headerLines !== undefined) {
      if (!Array.isArray(dto.headerLines)) {
        throw new BadRequestException('headerLines debe ser un arreglo');
      }
      if (dto.headerLines.length > 4) {
        throw new BadRequestException('headerLines puede tener un máximo de 4 líneas');
      }
      sanitizedHeaderLines = dto.headerLines.map((l) => sanitizeLine(l));
    }

    let sanitizedFooterLines: string[] | undefined = undefined;
    if (dto.footerLines !== undefined) {
      if (!Array.isArray(dto.footerLines)) {
        throw new BadRequestException('footerLines debe ser un arreglo');
      }
      if (dto.footerLines.length > 4) {
        throw new BadRequestException('footerLines puede tener un máximo de 4 líneas');
      }
      sanitizedFooterLines = dto.footerLines.map((l) => sanitizeLine(l));
    }

    if (dto.paperWidthMm !== undefined && dto.paperWidthMm !== 58 && dto.paperWidthMm !== 80) {
      throw new BadRequestException('paperWidthMm solo puede ser 58 u 80');
    }

    let sanitizedLogo: string | null | undefined = undefined;
    if (dto.logoImage !== undefined) {
      if (dto.logoImage === null || dto.logoImage === '') {
        sanitizedLogo = null;
      } else {
        let base64Data = dto.logoImage.trim();
        let mimeType = '';
        const match = base64Data.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
        if (match) {
          mimeType = match[1].toLowerCase();
          base64Data = match[2];
        }

        const buffer = Buffer.from(base64Data, 'base64');
        if (buffer.length === 0) {
          throw new BadRequestException('Formato de imagen en base64 inválido');
        }

        if (buffer.length > 100 * 1024) {
          throw new BadRequestException('La imagen del logo no debe superar los 100 KB');
        }

        let metadata: sharp.Metadata;
        try {
          const sharpInstance = (sharp as any).default || sharp;
          metadata = await sharpInstance(buffer).metadata();
        } catch {
          throw new BadRequestException('La imagen del logo no es una imagen válida');
        }

        if (metadata.format !== 'png' && metadata.format !== 'jpeg') {
          throw new BadRequestException('Solo se permiten imágenes en formato PNG o JPEG');
        }

        if (metadata.width && metadata.width > 576) {
          throw new BadRequestException('El ancho de la imagen no puede superar 576 px');
        }

        sanitizedLogo = `data:image/${metadata.format};base64,${base64Data}`;
      }
    }

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, posFooter: true },
    });
    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }

    return this.prisma.posReceiptSettings.upsert({
      where: { businessId },
      create: {
        businessId,
        logoImage: sanitizedLogo ?? null,
        showLogo: dto.showLogo ?? false,
        headerLines: sanitizedHeaderLines ?? [],
        footerLines:
          sanitizedFooterLines ??
          (business.posFooter ? [business.posFooter] : ['¡Gracias por su compra!']),
        showBusinessName: dto.showBusinessName ?? true,
        showAddress: dto.showAddress ?? true,
        showPhone: dto.showPhone ?? true,
        showTaxId: dto.showTaxId ?? true,
        showCashier: dto.showCashier ?? true,
        showCustomer: dto.showCustomer ?? true,
        showTaxBreakdown: dto.showTaxBreakdown ?? true,
        showBatches: dto.showBatches ?? false,
        paperWidthMm: dto.paperWidthMm ?? 80,
        updatedById: userId,
      },
      update: {
        ...(sanitizedLogo !== undefined ? { logoImage: sanitizedLogo } : {}),
        ...(dto.showLogo !== undefined ? { showLogo: dto.showLogo } : {}),
        ...(sanitizedHeaderLines !== undefined ? { headerLines: sanitizedHeaderLines } : {}),
        ...(sanitizedFooterLines !== undefined ? { footerLines: sanitizedFooterLines } : {}),
        ...(dto.showBusinessName !== undefined ? { showBusinessName: dto.showBusinessName } : {}),
        ...(dto.showAddress !== undefined ? { showAddress: dto.showAddress } : {}),
        ...(dto.showPhone !== undefined ? { showPhone: dto.showPhone } : {}),
        ...(dto.showTaxId !== undefined ? { showTaxId: dto.showTaxId } : {}),
        ...(dto.showCashier !== undefined ? { showCashier: dto.showCashier } : {}),
        ...(dto.showCustomer !== undefined ? { showCustomer: dto.showCustomer } : {}),
        ...(dto.showTaxBreakdown !== undefined
          ? { showTaxBreakdown: dto.showTaxBreakdown }
          : {}),
        ...(dto.showBatches !== undefined ? { showBatches: dto.showBatches } : {}),
        ...(dto.paperWidthMm !== undefined ? { paperWidthMm: dto.paperWidthMm } : {}),
        updatedById: userId,
        updatedAt: new Date(),
      },
    });
  }
}
