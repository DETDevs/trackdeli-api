import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SaleStatus, UserRole } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../../prisma/prisma.service';
import { UploadService } from '../../upload/upload.service';
import { generateShortCode } from '../../../common/utils/short-code.util';
import {
  DEFAULT_BUSINESS_TIMEZONE,
  formatDateInTimezone,
} from '../../../common/utils/date.util';
import { QUOTE_ERROR_CODES, QUOTE_STATUS } from '../quotes/pos-quotes.constants';

const MAX_RECEIPT_PDF_BYTES = 500 * 1024;
const RECEIPT_LINK_VALIDITY_MS = 90 * 24 * 60 * 60 * 1000;

export type ReceiptLinkDocumentKind = 'SALE' | 'QUOTE';
export type QuotePublicDisplayStatus =
  | 'VALID'
  | 'EXPIRED'
  | 'CONVERTED'
  | 'UNAVAILABLE';

export interface PublicReceiptDto {
  documentKind: ReceiptLinkDocumentKind;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'UNAVAILABLE';
  available?: boolean;
  code?: string;
  message?: string;
  businessName: string;
  folio: string;
  quoteNumber?: string;
  saleDate?: Date;
  issuedAt?: Date;
  validUntil?: Date | null;
  validUntilLabel?: string | null;
  total?: number;
  currency?: string;
  expiresAt?: Date;
  quoteStatus?: string;
  displayStatus?: QuotePublicDisplayStatus;
  displayStatusLabel?: string;
  pdfUrl?: string;
}

function formatDateDdMmYyyy(date?: Date | string | null): string | null {
  if (!date) return null;
  const ymd = formatDateInTimezone(date, DEFAULT_BUSINESS_TIMEZONE);
  if (!ymd) return null;
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y}`;
}

@Injectable()
export class ReceiptLinksService {
  private readonly logger = new Logger(ReceiptLinksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadService: UploadService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Resuelve la URL base de la API para construir la URL absoluta del endpoint PDF (/api/v1/public/receipts/:token/pdf).
   */
  getApiBaseUrl(req?: any): string {
    if (req) {
      const getHeader = (name: string) => {
        if (typeof req.get === 'function') {
          return req.get(name);
        }
        return req.headers ? req.headers[name.toLowerCase()] : undefined;
      };

      const forwardedProto = getHeader('x-forwarded-proto');
      const forwardedHost = getHeader('x-forwarded-host');
      const host = forwardedHost || getHeader('host');
      const proto = forwardedProto || req.protocol || 'http';
      if (host) return `${proto}://${host}`;
    }
    const apiUrl = this.configService.get<string>('API_URL');
    if (apiUrl && apiUrl.trim()) {
      return apiUrl.trim().replace(/\/+$/, '');
    }
    return 'http://localhost:3000';
  }

  /**
   * Resuelve la URL base de la web pública (tracking) configurada en RECEIPT_PUBLIC_URL.
   * Si no está definida, lanza un error y no utiliza dominios internos por fallback.
   */
  getReceiptPublicBaseUrl(): string {
    const receiptPublicUrl = this.configService.get<string>('RECEIPT_PUBLIC_URL');
    if (!receiptPublicUrl || !receiptPublicUrl.trim()) {
      this.logger.error(
        '[ReceiptLinksService] Variable RECEIPT_PUBLIC_URL no está configurada en el servidor. ' +
          'No se puede generar el enlace público para comprobantes.',
      );
      throw new BadRequestException(
        'Enlace no configurado: RECEIPT_PUBLIC_URL no está definida en el servidor',
      );
    }
    return receiptPublicUrl.trim().replace(/\/+$/, '');
  }

  private validatePdfUpload(file?: Express.Multer.File): Express.Multer.File {
    if (!file || !file.buffer) {
      throw new BadRequestException('Archivo PDF no proporcionado');
    }

    if (
      file.size > MAX_RECEIPT_PDF_BYTES ||
      file.buffer.length > MAX_RECEIPT_PDF_BYTES
    ) {
      throw new BadRequestException(
        'El archivo excede el tamaño máximo permitido de 500 KB',
      );
    }

    const magic = file.buffer.subarray(0, 4).toString('ascii');
    if (magic !== '%PDF') {
      throw new BadRequestException('El archivo no es un documento PDF válido');
    }

    return file;
  }

  private deletePreviousR2ObjectQuietly(
    previousKey: string | null | undefined,
    newKey: string,
    contextLabel: string,
  ): void {
    if (previousKey && previousKey !== newKey) {
      this.uploadService.deleteReceiptPdf(previousKey).catch((err) => {
        this.logger.warn(
          `Advertencia al limpiar PDF anterior de ${contextLabel}: ${err.message}`,
        );
      });
    }
  }

  private async syncAndResolveQuoteStatus(
    quote: { id: string; status: string; expiresAt: Date },
    now: Date,
  ): Promise<string> {
    if (
      (quote.status === QUOTE_STATUS.SENT ||
        quote.status === QUOTE_STATUS.ACCEPTED) &&
      quote.expiresAt <= now
    ) {
      await this.prisma.posQuote.updateMany({
        where: {
          id: quote.id,
          status: { in: [QUOTE_STATUS.SENT, QUOTE_STATUS.ACCEPTED] },
          expiresAt: { lte: now },
        },
        data: {
          status: QUOTE_STATUS.EXPIRED,
          expiredAt: now,
        },
      });
      return QUOTE_STATUS.EXPIRED;
    }

    return quote.status;
  }

  private mapQuoteDisplayStatus(quoteStatus: string): {
    displayStatus: QuotePublicDisplayStatus;
    displayStatusLabel: string;
  } {
    if (quoteStatus === QUOTE_STATUS.CONVERTED) {
      return {
        displayStatus: 'CONVERTED',
        displayStatusLabel: 'Convertida en venta',
      };
    }
    if (quoteStatus === QUOTE_STATUS.EXPIRED) {
      return {
        displayStatus: 'EXPIRED',
        displayStatusLabel: 'Vencida',
      };
    }
    if (quoteStatus === QUOTE_STATUS.CANCELLED) {
      return {
        displayStatus: 'UNAVAILABLE',
        displayStatusLabel: 'No disponible',
      };
    }
    return {
      displayStatus: 'VALID',
      displayStatusLabel: 'Vigente',
    };
  }

  /**
   * Sube un PDF generado por el desktop a R2 y genera o reutiliza un enlace seguro /comprobante/:token (90 días).
   */
  async uploadReceiptPdf(
    saleId: string,
    businessId: string,
    userId: string,
    file?: Express.Multer.File,
  ) {
    const validFile = this.validatePdfUpload(file);

    // Validar configuración obligatoria de RECEIPT_PUBLIC_URL antes de cualquier operación
    const publicWebBaseUrl = this.getReceiptPublicBaseUrl();

    // Buscar venta y validar pertenencia y estado
    const sale = await this.prisma.sale.findUnique({
      where: { id: saleId },
      include: {
        business: {
          select: { id: true, name: true, currency: true },
        },
        receiptLink: true,
      },
    });

    if (!sale) {
      throw new NotFoundException('Venta no encontrada');
    }

    if (sale.businessId !== businessId) {
      throw new ForbiddenException('No tienes permiso para acceder a esta venta');
    }

    if (sale.status === SaleStatus.CANCELLED) {
      throw new BadRequestException(
        'No se puede generar comprobante para una venta anulada',
      );
    }

    const now = new Date();

    // Si la venta ya tiene un enlace vigente, reutilizarlo (no subir otro a R2)
    const existingLink = sale.receiptLink;
    const isVigente =
      existingLink && !existingLink.revokedAt && existingLink.expiresAt > now;

    if (isVigente) {
      this.logger.log(
        `[uploadReceiptPdf] Reutilizando enlace vigente para venta ${sale.id} (token=${existingLink.token})`,
      );
      return {
        token: existingLink.token,
        url: `${publicWebBaseUrl}/comprobante/${existingLink.token}`,
        expiresAt: existingLink.expiresAt,
      };
    }

    // Generar nuevo token (16 caracteres CSPRNG) y subir a R2
    const token = generateShortCode(16);
    const objectKey = `receipts/${sale.businessId}/${sale.id}-${uuidv4()}.pdf`;

    await this.uploadService.uploadReceiptPdf(objectKey, validFile.buffer);
    this.deletePreviousR2ObjectQuietly(
      existingLink?.objectKey,
      objectKey,
      `venta ${sale.id}`,
    );

    const expiresAt = new Date(now.getTime() + RECEIPT_LINK_VALIDITY_MS);
    const businessName = sale.business?.name || 'Comercio';
    const folio = sale.invoiceNumber || sale.id.slice(0, 8);
    const saleDate = sale.invoiceDate || sale.createdAt;
    const total = Number(sale.total);
    const currency = sale.business?.currency || 'NIO';

    const saved = await this.prisma.posReceiptLink.upsert({
      where: { saleId: sale.id },
      create: {
        businessId: sale.businessId,
        documentKind: 'SALE',
        saleId: sale.id,
        quoteId: null,
        token,
        objectKey,
        fileSize: validFile.size,
        businessName,
        folio,
        saleDate,
        total,
        currency,
        expiresAt,
        revokedAt: null,
        viewCount: 0,
        lastViewedAt: null,
        createdById: userId,
      },
      update: {
        documentKind: 'SALE',
        saleId: sale.id,
        quoteId: null,
        token,
        objectKey,
        fileSize: validFile.size,
        businessName,
        folio,
        saleDate,
        total,
        currency,
        expiresAt,
        revokedAt: null,
        viewCount: 0,
        lastViewedAt: null,
        createdById: userId,
        createdAt: now,
      },
    });

    this.logger.log(
      `[uploadReceiptPdf] Comprobante digital creado para venta ${sale.id}: token=${saved.token}, folio=${folio}`,
    );

    return {
      token: saved.token,
      url: `${publicWebBaseUrl}/comprobante/${saved.token}`,
      expiresAt: saved.expiresAt,
    };
  }

  /**
   * 266b: Sube la proforma en PDF a R2 y genera o reutiliza un enlace público /proforma/:token (90 días).
   * Solo se comparte una proforma emitida (SENT, ACCEPTED, EXPIRED o CONVERTED).
   */
  async uploadQuoteReceiptPdf(
    quoteId: string,
    businessId: string,
    userId: string,
    userRole: string,
    file?: Express.Multer.File,
  ) {
    const validFile = this.validatePdfUpload(file);
    const publicWebBaseUrl = this.getReceiptPublicBaseUrl();

    const quote = await this.prisma.posQuote.findUnique({
      where: { id: quoteId },
      include: {
        business: {
          select: { id: true, name: true, currency: true },
        },
        receiptLink: true,
      },
    });

    if (!quote) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        code: QUOTE_ERROR_CODES.QUOTE_NOT_FOUND,
        message: 'Proforma no encontrada',
      });
    }

    if (quote.businessId !== businessId) {
      throw new ForbiddenException('No tienes permiso para acceder a esta proforma');
    }

    if (userRole === UserRole.VENDEDOR && quote.createdById !== userId) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: QUOTE_ERROR_CODES.QUOTE_FORBIDDEN,
        message: 'Solo puedes compartir tus propias proformas',
      });
    }

    const now = new Date();
    const effectiveStatus = await this.syncAndResolveQuoteStatus(quote, now);

    if (
      effectiveStatus === QUOTE_STATUS.DRAFT ||
      effectiveStatus === QUOTE_STATUS.CANCELLED
    ) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'QUOTE_NOT_SHAREABLE',
        message:
          effectiveStatus === QUOTE_STATUS.CANCELLED
            ? 'No se puede compartir una proforma cancelada'
            : 'La proforma debe emitirse antes de compartirse',
      });
    }

    const existingLink = quote.receiptLink;
    const isVigente =
      existingLink && !existingLink.revokedAt && existingLink.expiresAt > now;

    if (isVigente) {
      this.logger.log(
        `[uploadQuoteReceiptPdf] Reutilizando enlace vigente para proforma ${quote.id} (token=${existingLink.token})`,
      );
      return {
        token: existingLink.token,
        url: `${publicWebBaseUrl}/proforma/${existingLink.token}`,
        expiresAt: existingLink.expiresAt,
        documentKind: 'QUOTE' as const,
        quoteNumber: quote.quoteNumber,
      };
    }

    const token = generateShortCode(16);
    const objectKey = `quotes/${quote.businessId}/${quote.id}-${uuidv4()}.pdf`;

    await this.uploadService.uploadReceiptPdf(objectKey, validFile.buffer);
    this.deletePreviousR2ObjectQuietly(
      existingLink?.objectKey,
      objectKey,
      `proforma ${quote.id}`,
    );

    const expiresAt = new Date(now.getTime() + RECEIPT_LINK_VALIDITY_MS);
    const businessName = quote.business?.name || 'Comercio';
    const folio = quote.quoteNumber;
    const issuedAt = quote.sentAt || quote.createdAt;
    const total = Number(quote.total);
    const currency = quote.currency || quote.business?.currency || 'NIO';

    const saved = await this.prisma.posReceiptLink.upsert({
      where: { quoteId: quote.id },
      create: {
        businessId: quote.businessId,
        documentKind: 'QUOTE',
        saleId: null,
        quoteId: quote.id,
        token,
        objectKey,
        fileSize: validFile.size,
        businessName,
        folio,
        saleDate: issuedAt,
        total,
        currency,
        expiresAt,
        revokedAt: null,
        viewCount: 0,
        lastViewedAt: null,
        createdById: userId,
      },
      update: {
        documentKind: 'QUOTE',
        saleId: null,
        quoteId: quote.id,
        token,
        objectKey,
        fileSize: validFile.size,
        businessName,
        folio,
        saleDate: issuedAt,
        total,
        currency,
        expiresAt,
        revokedAt: null,
        viewCount: 0,
        lastViewedAt: null,
        createdById: userId,
        createdAt: now,
      },
    });

    this.logger.log(
      `[uploadQuoteReceiptPdf] Enlace público creado para proforma ${quote.id}: token=${saved.token}, folio=${folio}`,
    );

    return {
      token: saved.token,
      url: `${publicWebBaseUrl}/proforma/${saved.token}`,
      expiresAt: saved.expiresAt,
      documentKind: 'QUOTE' as const,
      quoteNumber: quote.quoteNumber,
    };
  }

  /**
   * Obtiene la información en formato JSON para el frontend web (GET /api/v1/public/receipts/:token).
   */
  async getPublicReceiptData(token: string, req?: any): Promise<PublicReceiptDto> {
    const link = await this.prisma.posReceiptLink.findUnique({
      where: { token },
      include: {
        quote: {
          select: {
            id: true,
            quoteNumber: true,
            status: true,
            expiresAt: true,
          },
        },
      },
    });

    if (!link) {
      throw new NotFoundException('Comprobante no encontrado');
    }

    const now = new Date();

    if (link.documentKind === 'QUOTE') {
      const effectiveQuoteStatus = link.quote
        ? await this.syncAndResolveQuoteStatus(link.quote, now)
        : QUOTE_STATUS.CANCELLED;

      if (!link.quote || effectiveQuoteStatus === QUOTE_STATUS.CANCELLED) {
        return {
          documentKind: 'QUOTE',
          status: 'UNAVAILABLE',
          available: false,
          code: QUOTE_ERROR_CODES.QUOTE_CANCELLED,
          message: 'Esta proforma fue cancelada y ya no está disponible.',
          businessName: link.businessName,
          folio: link.folio,
          quoteNumber: link.quote?.quoteNumber || link.folio,
          quoteStatus: QUOTE_STATUS.CANCELLED,
          displayStatus: 'UNAVAILABLE',
          displayStatusLabel: 'No disponible',
        };
      }

      const displayMeta = this.mapQuoteDisplayStatus(effectiveQuoteStatus);
      const validUntil = link.quote.expiresAt;
      const validUntilLabel = formatDateDdMmYyyy(validUntil);

      if (link.revokedAt !== null || link.expiresAt <= now) {
        const linkStatus = link.revokedAt !== null ? 'REVOKED' : 'EXPIRED';
        return {
          documentKind: 'QUOTE',
          status: linkStatus,
          available: false,
          code: linkStatus === 'REVOKED' ? 'LINK_REVOKED' : 'LINK_EXPIRED',
          message:
            'Este enlace de proforma ya no está disponible. Pídele al negocio que te lo envíe de nuevo.',
          businessName: link.businessName,
          folio: link.folio,
          quoteNumber: link.quote.quoteNumber,
          saleDate: link.saleDate,
          issuedAt: link.saleDate,
          validUntil,
          validUntilLabel,
          total: link.total,
          currency: link.currency,
          expiresAt: link.expiresAt,
          quoteStatus: effectiveQuoteStatus,
          displayStatus: displayMeta.displayStatus,
          displayStatusLabel: displayMeta.displayStatusLabel,
        };
      }

      const apiBase = this.getApiBaseUrl(req);
      return {
        documentKind: 'QUOTE',
        status: 'ACTIVE',
        available: true,
        businessName: link.businessName,
        folio: link.folio,
        quoteNumber: link.quote.quoteNumber,
        saleDate: link.saleDate,
        issuedAt: link.saleDate,
        validUntil,
        validUntilLabel,
        total: link.total,
        currency: link.currency,
        expiresAt: link.expiresAt,
        quoteStatus: effectiveQuoteStatus,
        displayStatus: displayMeta.displayStatus,
        displayStatusLabel: displayMeta.displayStatusLabel,
        pdfUrl: `${apiBase}/api/v1/public/receipts/${link.token}/pdf`,
      };
    }

    // Regresión 100% compatible para ventas (documentKind === 'SALE')
    let status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';

    if (link.revokedAt !== null) {
      status = 'REVOKED';
    } else if (link.expiresAt <= now) {
      status = 'EXPIRED';
    } else {
      status = 'ACTIVE';
    }

    const baseResponse: PublicReceiptDto = {
      documentKind: 'SALE',
      status,
      businessName: link.businessName,
      folio: link.folio,
      saleDate: link.saleDate,
      total: link.total,
      currency: link.currency,
      expiresAt: link.expiresAt,
    };

    if (status === 'ACTIVE') {
      const apiBase = this.getApiBaseUrl(req);
      baseResponse.pdfUrl = `${apiBase}/api/v1/public/receipts/${link.token}/pdf`;
    }

    return baseResponse;
  }

  /**
   * Transmite el archivo PDF directamente desde R2 a través de la API (stream).
   */
  async streamReceiptPdf(token: string, res: any) {
    const link = await this.prisma.posReceiptLink.findUnique({
      where: { token },
      include: {
        quote: {
          select: {
            id: true,
            status: true,
            expiresAt: true,
          },
        },
      },
    });

    if (!link) {
      throw new NotFoundException('Comprobante no encontrado');
    }

    const now = new Date();
    if (link.revokedAt !== null || link.expiresAt <= now) {
      throw new HttpException(
        'Este comprobante ya no está disponible. Pídele al negocio que te lo envíe de nuevo.',
        HttpStatus.GONE, // 410
      );
    }

    if (link.documentKind === 'QUOTE') {
      const effectiveQuoteStatus = link.quote
        ? await this.syncAndResolveQuoteStatus(link.quote, now)
        : QUOTE_STATUS.CANCELLED;

      if (!link.quote || effectiveQuoteStatus === QUOTE_STATUS.CANCELLED) {
        throw new HttpException(
          {
            statusCode: 410,
            error: 'Gone',
            code: QUOTE_ERROR_CODES.QUOTE_CANCELLED,
            message: 'Esta proforma fue cancelada y ya no está disponible.',
          },
          HttpStatus.GONE,
        );
      }
    }

    if (!link.objectKey) {
      throw new NotFoundException('El archivo PDF no está disponible');
    }

    // Incrementar viewCount y actualizar lastViewedAt de forma asíncrona
    this.prisma.posReceiptLink
      .update({
        where: { id: link.id },
        data: {
          viewCount: { increment: 1 },
          lastViewedAt: now,
        },
      })
      .catch((err) => {
        this.logger.warn(
          `Error al actualizar métricas de visualización: ${err.message}`,
        );
      });

    const { stream, contentLength } =
      await this.uploadService.getReceiptPdfStream(link.objectKey);

    const safeFolio = (link.folio || 'documento').replace(/[^a-zA-Z0-9_\-]/g, '_');
    const filePrefix =
      link.documentKind === 'QUOTE' ? 'Proforma' : 'Comprobante';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${filePrefix}-${safeFolio}.pdf"`,
    );
    res.setHeader('X-Robots-Tag', 'noindex');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    stream.pipe(res);
  }

  /**
   * Revoca un comprobante digital (solo ENCARGADO / SUPERADMIN): marca revokedAt y elimina de R2.
   */
  async revokeReceiptLink(saleId: string, businessId: string, userRole: string) {
    const sale = await this.prisma.sale.findUnique({
      where: { id: saleId },
      select: { id: true, businessId: true },
    });

    if (!sale) {
      throw new NotFoundException('Venta no encontrada');
    }

    if (sale.businessId !== businessId && userRole !== UserRole.SUPERADMIN) {
      throw new ForbiddenException('No tienes permiso para acceder a esta venta');
    }

    const link = await this.prisma.posReceiptLink.findUnique({
      where: { saleId },
    });

    if (!link) {
      throw new NotFoundException('No existe comprobante digital para esta venta');
    }

    if (link.revokedAt) {
      return {
        success: true,
        message: 'El comprobante ya fue revocado previamente',
        revokedAt: link.revokedAt,
      };
    }

    if (link.objectKey) {
      try {
        await this.uploadService.deleteReceiptPdf(link.objectKey);
      } catch (e: any) {
        this.logger.warn(`Error borrando objeto de R2 al revocar: ${e.message}`);
      }
    }

    const now = new Date();
    const updated = await this.prisma.posReceiptLink.update({
      where: { id: link.id },
      data: {
        revokedAt: now,
        objectKey: '',
      },
    });

    this.logger.log(
      `[revokeReceiptLink] Comprobante revocado para venta ${saleId}`,
    );

    return {
      success: true,
      message: 'Comprobante revocado exitosamente',
      revokedAt: updated.revokedAt,
    };
  }

  /**
   * Cron diario de limpieza que borra de R2 los comprobantes y proformas vencidos (>90 días) y vacía objectKey.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupExpiredReceipts(): Promise<{ cleanedCount: number }> {
    this.logger.log(
      '[ReceiptLinksService] Iniciando limpieza diaria de comprobantes y proformas vencidos en R2...',
    );
    try {
      const now = new Date();
      const expiredLinks = await this.prisma.posReceiptLink.findMany({
        where: {
          expiresAt: { lte: now },
          objectKey: { not: '' },
        },
        select: { id: true, objectKey: true, documentKind: true },
        take: 500,
      });

      let cleanedCount = 0;
      for (const link of expiredLinks) {
        if (link.objectKey) {
          try {
            await this.uploadService.deleteReceiptPdf(link.objectKey);
          } catch (e: any) {
            this.logger.warn(
              `Error eliminando de R2 en limpieza: ${e.message}`,
            );
          }
        }
        await this.prisma.posReceiptLink.update({
          where: { id: link.id },
          data: { objectKey: '' },
        });
        cleanedCount++;
      }

      this.logger.log(
        `[ReceiptLinksService] Limpieza completada: ${cleanedCount} objeto(s) eliminados de R2.`,
      );
      return { cleanedCount };
    } catch (err: any) {
      this.logger.error(
        `[ReceiptLinksService] Error en limpieza de comprobantes: ${err.message}`,
        err.stack,
      );
      return { cleanedCount: 0 };
    }
  }
}
