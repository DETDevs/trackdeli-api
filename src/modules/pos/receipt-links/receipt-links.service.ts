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

export interface PublicReceiptDto {
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  businessName: string;
  folio: string;
  saleDate: Date;
  total: number;
  currency: string;
  expiresAt: Date;
  pdfUrl?: string;
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
      throw new BadRequestException('Enlace no configurado: RECEIPT_PUBLIC_URL no está definida en el servidor');
    }
    return receiptPublicUrl.trim().replace(/\/+$/, '');
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
    if (!file || !file.buffer) {
      throw new BadRequestException('Archivo PDF no proporcionado');
    }

    // 1. Validar tamaño (máximo 500 KB = 512,000 bytes)
    const MAX_SIZE_BYTES = 500 * 1024;
    if (file.size > MAX_SIZE_BYTES || file.buffer.length > MAX_SIZE_BYTES) {
      throw new BadRequestException('El archivo excede el tamaño máximo permitido de 500 KB');
    }

    // 2. Validar bytes mágicos: debe iniciar con %PDF
    const magic = file.buffer.subarray(0, 4).toString('ascii');
    if (magic !== '%PDF') {
      throw new BadRequestException('El archivo no es un documento PDF válido');
    }

    // 3. Validar configuración obligatoria de RECEIPT_PUBLIC_URL antes de cualquier operación
    const publicWebBaseUrl = this.getReceiptPublicBaseUrl();

    // 4. Buscar venta y validar pertenencia y estado
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
      throw new BadRequestException('No se puede generar comprobante para una venta anulada');
    }

    const now = new Date();

    // 5. Si la venta ya tiene un enlace vigente, reutilizarlo (no subir otro a R2)
    const existingLink = sale.receiptLink;
    const isVigente = existingLink && !existingLink.revokedAt && existingLink.expiresAt > now;

    if (isVigente) {
      this.logger.log(`[uploadReceiptPdf] Reutilizando enlace vigente para venta ${sale.id} (token=${existingLink.token})`);
      return {
        token: existingLink.token,
        url: `${publicWebBaseUrl}/comprobante/${existingLink.token}`,
        expiresAt: existingLink.expiresAt,
      };
    }

    // 6. Si no tiene o está vencido/revocado, generar nuevo token (16 caracteres CSPRNG) y subir a R2
    const token = generateShortCode(16);
    const objectKey = `receipts/${sale.businessId}/${sale.id}-${uuidv4()}.pdf`;

    await this.uploadService.uploadReceiptPdf(objectKey, file.buffer);

    // Si había un PDF previo en R2 para esta venta, borrarlo de forma asíncrona
    if (existingLink && existingLink.objectKey && existingLink.objectKey !== objectKey) {
      this.uploadService.deleteReceiptPdf(existingLink.objectKey).catch((err) => {
        this.logger.warn(`Advertencia al limpiar PDF anterior de venta ${sale.id}: ${err.message}`);
      });
    }

    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000); // 90 días
    const businessName = sale.business?.name || 'Comercio';
    const folio = sale.invoiceNumber || sale.id.slice(0, 8);
    const saleDate = sale.invoiceDate || sale.createdAt;
    const total = Number(sale.total);
    const currency = sale.business?.currency || 'NIO';

    const saved = await this.prisma.posReceiptLink.upsert({
      where: { saleId: sale.id },
      create: {
        businessId: sale.businessId,
        saleId: sale.id,
        token,
        objectKey,
        fileSize: file.size,
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
        token,
        objectKey,
        fileSize: file.size,
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
        createdAt: new Date(),
      },
    });

    this.logger.log(`[uploadReceiptPdf] Comprobante digital creado para venta ${sale.id}: token=${saved.token}, folio=${folio}`);

    return {
      token: saved.token,
      url: `${publicWebBaseUrl}/comprobante/${saved.token}`,
      expiresAt: saved.expiresAt,
    };
  }

  /**
   * Obtiene la información en formato JSON para el frontend web (GET /api/v1/public/receipts/:token).
   */
  async getPublicReceiptData(token: string, req?: any): Promise<PublicReceiptDto> {
    const link = await this.prisma.posReceiptLink.findUnique({
      where: { token },
      select: {
        token: true,
        businessName: true,
        folio: true,
        saleDate: true,
        total: true,
        currency: true,
        expiresAt: true,
        revokedAt: true,
      },
    });

    if (!link) {
      throw new NotFoundException('Comprobante no encontrado');
    }

    const now = new Date();
    let status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';

    if (link.revokedAt !== null) {
      status = 'REVOKED';
    } else if (link.expiresAt <= now) {
      status = 'EXPIRED';
    } else {
      status = 'ACTIVE';
    }

    const baseResponse: PublicReceiptDto = {
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
        this.logger.warn(`Error al actualizar métricas de visualización: ${err.message}`);
      });

    const { stream, contentLength } = await this.uploadService.getReceiptPdfStream(link.objectKey);

    const safeFolio = (link.folio || 'venta').replace(/[^a-zA-Z0-9_\-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Comprobante-${safeFolio}.pdf"`);
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

    // Eliminar archivo de R2
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
        objectKey: '', // Registro queda con objectKey vacío
      },
    });

    this.logger.log(`[revokeReceiptLink] Comprobante revocado para venta ${saleId}`);

    return {
      success: true,
      message: 'Comprobante revocado exitosamente',
      revokedAt: updated.revokedAt,
    };
  }

  /**
   * Cron diario de limpieza que borra de R2 los comprobantes vencidos (>90 días) y vacía objectKey.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupExpiredReceipts(): Promise<{ cleanedCount: number }> {
    this.logger.log('[ReceiptLinksService] Iniciando limpieza diaria de comprobantes vencidos en R2...');
    try {
      const now = new Date();
      const expiredLinks = await this.prisma.posReceiptLink.findMany({
        where: {
          expiresAt: { lte: now },
          objectKey: { not: '' },
        },
        select: { id: true, objectKey: true },
        take: 500,
      });

      let cleanedCount = 0;
      for (const link of expiredLinks) {
        if (link.objectKey) {
          try {
            await this.uploadService.deleteReceiptPdf(link.objectKey);
          } catch (e: any) {
            this.logger.warn(`Error eliminando de R2 en limpieza: ${e.message}`);
          }
        }
        await this.prisma.posReceiptLink.update({
          where: { id: link.id },
          data: { objectKey: '' },
        });
        cleanedCount++;
      }

      this.logger.log(`[ReceiptLinksService] Limpieza completada: ${cleanedCount} objeto(s) eliminados de R2.`);
      return { cleanedCount };
    } catch (err: any) {
      this.logger.error(`[ReceiptLinksService] Error en limpieza de comprobantes: ${err.message}`, err.stack);
      return { cleanedCount: 0 };
    }
  }
}
