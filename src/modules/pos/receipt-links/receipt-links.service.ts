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

function escapeHtml(str: any): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
   * Resuelve la URL base pública para los enlaces /r/:token con fallback ordenado.
   */
  getBaseUrl(req?: any): string {
    const configured = this.configService.get<string>('RECEIPT_PUBLIC_URL');
    if (configured && configured.trim()) {
      return configured.trim().replace(/\/+$/, '');
    }
    if (req && req.get) {
      const host = req.get('host');
      const proto = req.protocol || 'http';
      if (host) return `${proto}://${host}`;
    }
    const trackingUrl = this.configService.get<string>('TRACKING_URL');
    if (trackingUrl && trackingUrl.trim()) {
      return trackingUrl.trim().replace(/\/+$/, '');
    }
    return 'http://localhost:3000';
  }

  /**
   * Sube un PDF generado por el desktop a R2 y genera o reutiliza un enlace seguro /r/:token (90 días).
   */
  async uploadReceiptPdf(
    saleId: string,
    businessId: string,
    userId: string,
    file?: Express.Multer.File,
    req?: any,
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

    // 3. Buscar venta y validar pertenencia y estado
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

    const baseUrl = this.getBaseUrl(req);
    const now = new Date();

    // 4. Si la venta ya tiene un enlace vigente, reutilizarlo (no subir otro a R2)
    const existingLink = sale.receiptLink;
    const isVigente = existingLink && !existingLink.revokedAt && existingLink.expiresAt > now;

    if (isVigente) {
      this.logger.log(`[uploadReceiptPdf] Reutilizando enlace vigente para venta ${sale.id} (token=${existingLink.token})`);
      return {
        token: existingLink.token,
        url: `${baseUrl}/r/${existingLink.token}`,
        expiresAt: existingLink.expiresAt,
      };
    }

    // 5. Si no tiene o está vencido/revocado, generar nuevo token (16 caracteres CSPRNG) y subir a R2
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
      url: `${baseUrl}/r/${saved.token}`,
      expiresAt: saved.expiresAt,
    };
  }

  /**
   * Obtiene la información para la página pública /r/:token usando únicamente el snapshot guardado.
   */
  async getPublicReceiptData(token: string) {
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
      return { status: 'NOT_FOUND' as const };
    }

    const now = new Date();
    if (link.revokedAt !== null || link.expiresAt <= now) {
      return { status: 'EXPIRED_OR_REVOKED' as const, link };
    }

    return { status: 'ACTIVE' as const, link };
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
        HttpStatus.GONE,
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
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
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
    this.logger.log('[ReceiptLinksService] Iniciando limpieza de comprobantes vencidos en R2...');
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

  /**
   * Renderiza la página HTML liviana y móvil primero para /r/:token sin frameworks.
   */
  renderReceiptHtml(data: {
    status: 'ACTIVE' | 'EXPIRED_OR_REVOKED' | 'NOT_FOUND';
    link?: any;
  }): string {
    const isNotFound = data.status === 'NOT_FOUND';
    const isExpiredOrRevoked = data.status === 'EXPIRED_OR_REVOKED';
    const link = data.link;

    let bodyContent = '';

    if (isNotFound) {
      bodyContent = `
        <div class="card status-card">
          <div class="icon-badge icon-warning">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          </div>
          <h1 class="card-title">Comprobante no encontrado</h1>
          <p class="card-text">El enlace ingresado no es válido o no existe.</p>
        </div>
      `;
    } else if (isExpiredOrRevoked) {
      bodyContent = `
        <div class="card status-card">
          <div class="icon-badge icon-warning">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
          </div>
          <h1 class="card-title">Comprobante no disponible</h1>
          <p class="card-text">Este comprobante ya no está disponible. Pídele al negocio que te lo envíe de nuevo.</p>
        </div>
      `;
    } else {
      const formattedDate = link?.saleDate
        ? new Date(link.saleDate).toLocaleDateString('es-ES', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : '';
      const formattedTotal = Number(link?.total || 0).toLocaleString('es-NI', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

      bodyContent = `
        <div class="card">
          <header class="header">
            <h2 class="business-name">${escapeHtml(link?.businessName)}</h2>
            <div class="doc-badge">Comprobante de venta</div>
          </header>

          <div class="divider"></div>

          <div class="details-list">
            <div class="detail-row">
              <span class="detail-label">Folio</span>
              <span class="detail-value font-mono">#${escapeHtml(link?.folio)}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Fecha</span>
              <span class="detail-value">${escapeHtml(formattedDate)}</span>
            </div>
            <div class="detail-row total-row">
              <span class="detail-label">Total</span>
              <span class="detail-value total-value">${escapeHtml(link?.currency)} ${formattedTotal}</span>
            </div>
          </div>

          <div class="action-section">
            <a href="/r/${escapeHtml(link?.token)}/pdf" class="btn btn-primary" target="_blank" rel="noopener">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
              Ver / descargar PDF
            </a>
          </div>

          <footer class="footer-note">
            Documento digital emitido por el negocio.
          </footer>
        </div>
      `;
    }

    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <meta name="robots" content="noindex, nofollow" />
  <meta name="referrer" content="no-referrer" />
  <title>Comprobante de venta</title>
  <style>
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: #f3f4f6;
      color: #1f2937;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      -webkit-font-smoothing: antialiased;
    }
    .card {
      background: #ffffff;
      width: 100%;
      max-width: 440px;
      border-radius: 16px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.08), 0 8px 10px -6px rgba(0, 0, 0, 0.04);
      padding: 28px 24px;
      border: 1px solid #e5e7eb;
    }
    .status-card {
      text-align: center;
      padding: 40px 24px;
    }
    .icon-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      margin-bottom: 20px;
    }
    .icon-warning {
      background-color: #fef3c7;
      color: #d97706;
    }
    .card-title {
      font-size: 1.25rem;
      font-weight: 700;
      color: #111827;
      margin-bottom: 10px;
    }
    .card-text {
      font-size: 0.95rem;
      color: #4b5563;
      line-height: 1.5;
    }
    .header {
      text-align: center;
      margin-bottom: 20px;
    }
    .business-name {
      font-size: 1.35rem;
      font-weight: 700;
      color: #111827;
      line-height: 1.3;
      word-break: break-word;
    }
    .doc-badge {
      display: inline-block;
      margin-top: 8px;
      padding: 4px 12px;
      border-radius: 20px;
      background-color: #f3f4f6;
      color: #4b5563;
      font-size: 0.8rem;
      font-weight: 600;
      letter-spacing: 0.025em;
      text-transform: uppercase;
    }
    .divider {
      height: 1px;
      background-color: #e5e7eb;
      margin: 18px 0;
    }
    .details-list {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .detail-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.95rem;
    }
    .detail-label {
      color: #6b7280;
      font-weight: 500;
    }
    .detail-value {
      color: #111827;
      font-weight: 600;
      text-align: right;
    }
    .font-mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .total-row {
      padding-top: 14px;
      border-top: 1px dashed #e5e7eb;
      margin-top: 4px;
    }
    .total-row .detail-label {
      font-size: 1.05rem;
      font-weight: 700;
      color: #111827;
    }
    .total-value {
      font-size: 1.35rem;
      font-weight: 800;
      color: #059669;
    }
    .action-section {
      margin-top: 28px;
    }
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      width: 100%;
      padding: 14px 20px;
      border-radius: 12px;
      font-size: 1rem;
      font-weight: 600;
      text-decoration: none;
      transition: background-color 0.15s ease, transform 0.05s ease;
      cursor: pointer;
    }
    .btn:active {
      transform: scale(0.98);
    }
    .btn-primary {
      background-color: #2563eb;
      color: #ffffff;
      box-shadow: 0 4px 12px rgba(37, 99, 235, 0.25);
    }
    .btn-primary:hover {
      background-color: #1d4ed8;
    }
    .footer-note {
      text-align: center;
      font-size: 0.78rem;
      color: #9ca3af;
      margin-top: 20px;
    }
  </style>
</head>
<body>
  ${bodyContent}
</body>
</html>`;
  }
}
