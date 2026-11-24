import {
  BadRequestException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  buildInternalEan13,
  INTERNAL_BARCODE_PREFIX,
  MAX_INTERNAL_BARCODE_SEQUENCE,
} from './barcode.util';
import { GenerateMissingBarcodesDto } from './dto/generate-missing-barcodes.dto';

export const MAX_BARCODES_PER_BATCH = 2000;

@Injectable()
export class ProductBarcodesService {
  private readonly logger = new Logger(ProductBarcodesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 303a - Reserva y devuelve un único código EAN-13 interno (prefijo 20) libre para el negocio.
   * No lo asigna a ningún producto; usa bloqueo de fila FOR UPDATE sobre pos_barcode_sequences
   * para garantizar unicidad incluso ante peticiones simultáneas.
   */
  async nextBarcode(businessId: string): Promise<{
    barcode: string;
    sequenceNumber: number;
  }> {
    return this.prisma.$transaction(async (tx) => {
      const currentLast = await this.lockAndGetSequence(tx, businessId);
      const { barcode, nextSequence } = await this.allocateSingleFreeBarcode(
        tx,
        businessId,
        currentLast,
      );

      await tx.$executeRawUnsafe(
        `UPDATE "pos_barcode_sequences"
         SET "last_number" = $2, "updated_at" = NOW()
         WHERE "business_id" = $1`,
        businessId,
        nextSequence,
      );

      this.logger.log(
        `[nextBarcode] businessId=${businessId} barcode=${barcode} seq=${nextSequence.toString()}`,
      );

      return {
        barcode,
        sequenceNumber: Number(nextSequence),
      };
    });
  }

  /**
   * 303a - Cuenta (dryRun: true, por defecto) o genera y guarda (dryRun: false) códigos EAN-13 internos
   * para todos los productos simples activos y variantes activas sin código de barras.
   * Nunca modifica códigos existentes ni asigna código a padres con variantes ni a inactivos.
   */
  async generateMissingBarcodes(
    businessId: string,
    dto: GenerateMissingBarcodesDto = {},
  ): Promise<{
    dryRun: boolean;
    eligible: number;
    wouldGenerate?: number;
    generated: number;
    skipped: number;
    remaining: number;
    maxPerCall: number;
    errors: Array<{ productId: string; name: string; code: string; message: string }>;
  }> {
    const dryRun = dto.dryRun !== undefined ? Boolean(dto.dryRun) : true;
    const requestedLimit = dto.limit !== undefined ? Number(dto.limit) : MAX_BARCODES_PER_BATCH;

    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'INVALID_BARCODE_LIMIT',
        message: 'El límite por llamada debe ser un número entero mayor o igual a 1.',
      });
    }

    if (requestedLimit > MAX_BARCODES_PER_BATCH) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'BARCODE_LIMIT_EXCEEDED',
        message: `No podés generar más de ${MAX_BARCODES_PER_BATCH.toLocaleString('en-US')} códigos por llamada. Ajustá el límite o ejecutá otro lote.`,
      });
    }

    // Modo simulación: solo cuenta cuántos se generarían, sin tocar el contador ni productos
    if (dryRun) {
      const eligible = await this.countEligibleWithoutBarcode(this.prisma, businessId);
      const wouldGenerate = Math.min(eligible, requestedLimit);
      const remaining = Math.max(0, eligible - wouldGenerate);

      return {
        dryRun: true,
        eligible,
        wouldGenerate,
        generated: 0,
        skipped: 0,
        remaining,
        maxPerCall: MAX_BARCODES_PER_BATCH,
        errors: [],
      };
    }

    // Modo escritura: todo o nada por lote dentro de una transacción con bloqueo de secuencia
    return this.prisma.$transaction(
      async (tx) => {
        const currentLast = await this.lockAndGetSequence(tx, businessId);

        const totalEligible = await this.countEligibleWithoutBarcode(tx, businessId);
        if (totalEligible === 0) {
          return {
            dryRun: false,
            eligible: 0,
            generated: 0,
            skipped: 0,
            remaining: 0,
            maxPerCall: MAX_BARCODES_PER_BATCH,
            errors: [],
          };
        }

        const targets: Array<{ id: string; name: string }> = await tx.$queryRawUnsafe(
          `SELECT p."id", p."name"
           FROM "pos_products" p
           LEFT JOIN "pos_products" parent ON parent."id" = p."parentProductId"
           WHERE p."businessId" = $1
             AND p."isActive" = true
             AND p."isVariantParent" = false
             AND (p."barcode" IS NULL OR btrim(p."barcode") = '')
             AND (p."parentProductId" IS NULL OR parent."isActive" = true)
           ORDER BY p."createdAt" ASC, p."id" ASC
           LIMIT $2
           FOR UPDATE OF p`,
          businessId,
          requestedLimit,
        );

        if (targets.length === 0) {
          return {
            dryRun: false,
            eligible: 0,
            generated: 0,
            skipped: 0,
            remaining: 0,
            maxPerCall: MAX_BARCODES_PER_BATCH,
            errors: [],
          };
        }

        // Precargar todos los códigos existentes del negocio que empiecen con '20'
        // (tanto en pos_products como en pos_product_presentations) para saltar colisiones sin N consultas
        const existingSet = await this.loadExistingInternalBarcodes(tx, businessId);

        let seq = currentLast;
        let generated = 0;
        let skipped = 0;

        for (const item of targets) {
          let candidate: string | null = null;
          while (candidate === null) {
            seq += 1n;
            if (seq > MAX_INTERNAL_BARCODE_SEQUENCE) {
              throw new UnprocessableEntityException({
                statusCode: 422,
                error: 'Unprocessable Entity',
                code: 'BARCODE_SEQUENCE_EXHAUSTED',
                message:
                  'Se alcanzó el límite máximo de códigos de barras internos para este negocio.',
              });
            }
            const code = buildInternalEan13(seq);
            if (!existingSet.has(code)) {
              candidate = code;
              existingSet.add(code);
            }
          }

          // Guarda de seguridad en SQL: nunca sobrescribe un código existente
          const updatedCount: number = await tx.$executeRawUnsafe(
            `UPDATE "pos_products"
             SET "barcode" = $2, "updatedAt" = NOW()
             WHERE "id" = $1
               AND "businessId" = $3
               AND ("barcode" IS NULL OR btrim("barcode") = '')`,
            item.id,
            candidate,
            businessId,
          );

          if (updatedCount > 0) {
            generated++;
          } else {
            skipped++;
          }
        }

        await tx.$executeRawUnsafe(
          `UPDATE "pos_barcode_sequences"
           SET "last_number" = $2, "updated_at" = NOW()
           WHERE "business_id" = $1`,
          businessId,
          seq,
        );

        const remaining = Math.max(0, totalEligible - generated - skipped);

        this.logger.log(
          `[generateMissingBarcodes] businessId=${businessId} generated=${generated} skipped=${skipped} remaining=${remaining} lastSeq=${seq.toString()}`,
        );

        return {
          dryRun: false,
          eligible: totalEligible,
          generated,
          skipped,
          remaining,
          maxPerCall: MAX_BARCODES_PER_BATCH,
          errors: [],
        };
      },
      { timeout: 60000 },
    );
  }

  private async lockAndGetSequence(
    tx: Prisma.TransactionClient,
    businessId: string,
  ): Promise<bigint> {
    await tx.$executeRawUnsafe(
      `INSERT INTO "pos_barcode_sequences" ("business_id", "last_number", "updated_at")
       VALUES ($1, 0, NOW())
       ON CONFLICT ("business_id") DO NOTHING`,
      businessId,
    );

    const rows: Array<{ last_number: bigint | string | number }> = await tx.$queryRawUnsafe(
      `SELECT "last_number"
       FROM "pos_barcode_sequences"
       WHERE "business_id" = $1
       FOR UPDATE`,
      businessId,
    );

    const raw = rows[0]?.last_number ?? 0;
    return BigInt(raw);
  }

  private async allocateSingleFreeBarcode(
    tx: Prisma.TransactionClient,
    businessId: string,
    currentLast: bigint,
  ): Promise<{ barcode: string; nextSequence: bigint }> {
    let seq = currentLast;

    while (true) {
      seq += 1n;
      if (seq > MAX_INTERNAL_BARCODE_SEQUENCE) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: 'BARCODE_SEQUENCE_EXHAUSTED',
          message:
            'Se alcanzó el límite máximo de códigos de barras internos para este negocio.',
        });
      }

      const candidate = buildInternalEan13(seq);

      const [existingProd, existingPres] = await Promise.all([
        tx.product.findFirst({
          where: { businessId, barcode: candidate },
          select: { id: true },
        }),
        tx.productPresentation.findFirst({
          where: { businessId, barcode: candidate },
          select: { id: true },
        }),
      ]);

      if (!existingProd && !existingPres) {
        return { barcode: candidate, nextSequence: seq };
      }
    }
  }

  private async loadExistingInternalBarcodes(
    tx: Prisma.TransactionClient,
    businessId: string,
  ): Promise<Set<string>> {
    const prefixPattern = `${INTERNAL_BARCODE_PREFIX}%`;
    const [prodRows, presRows] = await Promise.all([
      tx.$queryRawUnsafe<Array<{ barcode: string }>>(
        `SELECT "barcode" FROM "pos_products"
         WHERE "businessId" = $1 AND "barcode" LIKE $2`,
        businessId,
        prefixPattern,
      ),
      tx.$queryRawUnsafe<Array<{ barcode: string }>>(
        `SELECT "barcode" FROM "pos_product_presentations"
         WHERE "businessId" = $1 AND "barcode" LIKE $2`,
        businessId,
        prefixPattern,
      ),
    ]);

    const set = new Set<string>();
    for (const r of prodRows) {
      if (r.barcode) set.add(r.barcode.trim());
    }
    for (const r of presRows) {
      if (r.barcode) set.add(r.barcode.trim());
    }
    return set;
  }

  private async countEligibleWithoutBarcode(
    db: PrismaService | Prisma.TransactionClient,
    businessId: string,
  ): Promise<number> {
    const rows: Array<{ count: number | string | bigint }> = await (db as any).$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
       FROM "pos_products" p
       LEFT JOIN "pos_products" parent ON parent."id" = p."parentProductId"
       WHERE p."businessId" = $1
         AND p."isActive" = true
         AND p."isVariantParent" = false
         AND (p."barcode" IS NULL OR btrim(p."barcode") = '')
         AND (p."parentProductId" IS NULL OR parent."isActive" = true)`,
      businessId,
    );

    return Number(rows[0]?.count ?? 0);
  }
}
