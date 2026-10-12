import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';

@Injectable()
export class KitchenService {
  private readonly logger = new Logger(KitchenService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Obtiene las rondas pendientes de impresión (PENDING y PRINTING de más de 60s sin confirmar).
   * Ordenadas por fecha de creación ascendente (la más antigua primero).
   */
  async getPendingPrint(businessId: string) {
    const rounds: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT r.id,
              r.business_id AS "businessId",
              r.table_order_id AS "tableOrderId",
              r.table_id AS "tableId",
              r.number,
              r.type,
              r.status,
              r.print_status AS "printStatus",
              r.print_attempts AS "printAttempts",
              r.printed_at AS "printedAt",
              r.claimed_by AS "claimedBy",
              r.claimed_at AS "claimedAt",
              r.created_by AS "createdBy",
              r.created_at AS "createdAt",
              r.client_request_id AS "clientRequestId",
              r.items,
              r.reason,
              r.authorized_by AS "authorizedBy",
              t.number AS "tableNumber",
              z.name AS "zoneName"
       FROM "kitchen_rounds" r
       JOIN "pos_restaurant_tables" t ON t."id" = r."table_id"
       LEFT JOIN "pos_salon_zones" z ON z."id" = t."zoneId"
       WHERE r."business_id" = $1
         AND (
           r."print_status" = 'PENDING'
           OR (
             r."print_status" = 'PRINTING'
             AND r."claimed_at" < NOW() - INTERVAL '60 seconds'
           )
         )
       ORDER BY r."created_at" ASC`,
      businessId,
    );

    return rounds;
  }

  /**
   * Reclama una ronda atómicamente pasando PENDING -> PRINTING.
   * Si otra estación ya la tomó (o está en PRINTING < 60s), lanza 409 Conflict.
   */
  async claimPrint(businessId: string, roundId: string, claimedBy?: string) {
    const identifier = (claimedBy || 'desktop-station').trim();

    const updated: any[] = await this.prisma.$queryRawUnsafe(
      `UPDATE "kitchen_rounds"
       SET "print_status" = 'PRINTING',
           "claimed_by" = $1,
           "claimed_at" = NOW(),
           "print_attempts" = "print_attempts" + 1
       WHERE "id" = $2
         AND "business_id" = $3
         AND (
           "print_status" = 'PENDING'
           OR (
             "print_status" = 'PRINTING'
             AND "claimed_at" < NOW() - INTERVAL '60 seconds'
           )
         )
       RETURNING id,
                 business_id AS "businessId",
                 table_order_id AS "tableOrderId",
                 table_id AS "tableId",
                 number,
                 type,
                 status,
                 print_status AS "printStatus",
                 print_attempts AS "printAttempts",
                 printed_at AS "printedAt",
                 claimed_by AS "claimedBy",
                 claimed_at AS "claimedAt",
                 created_by AS "createdBy",
                 created_at AS "createdAt",
                 items,
                 reason,
                 authorized_by AS "authorizedBy"`,
      identifier,
      roundId,
      businessId,
    );

    if (updated.length > 0) {
      return updated[0];
    }

    // Si no actualizó nada, verificamos si existe la ronda
    const existing: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT id, print_status AS "printStatus", claimed_at AS "claimedAt"
       FROM "kitchen_rounds"
       WHERE "id" = $1 AND "business_id" = $2`,
      roundId,
      businessId,
    );

    if (existing.length === 0) {
      throw new NotFoundException('Ronda no encontrada');
    }

    throw new ConflictException(
      'La ronda ya fue reclamada por otra estación o no está pendiente de impresión',
    );
  }

  /**
   * Confirma que la ronda se imprimió exitosamente.
   */
  async markPrinted(businessId: string, roundId: string) {
    const updated: any[] = await this.prisma.$queryRawUnsafe(
      `UPDATE "kitchen_rounds"
       SET "print_status" = 'PRINTED',
           "printed_at" = NOW()
       WHERE "id" = $1 AND "business_id" = $2
       RETURNING id,
                 business_id AS "businessId",
                 table_order_id AS "tableOrderId",
                 table_id AS "tableId",
                 number,
                 type,
                 status,
                 print_status AS "printStatus",
                 print_attempts AS "printAttempts",
                 printed_at AS "printedAt",
                 claimed_by AS "claimedBy",
                 claimed_at AS "claimedAt",
                 created_by AS "createdBy",
                 created_at AS "createdAt",
                 items`,
      roundId,
      businessId,
    );

    if (updated.length === 0) {
      throw new NotFoundException('Ronda no encontrada');
    }

    return updated[0];
  }

  /**
   * Registra fallo de impresión para la ronda.
   */
  async markPrintFailed(businessId: string, roundId: string, error?: string) {
    const updated: any[] = await this.prisma.$queryRawUnsafe(
      `UPDATE "kitchen_rounds"
       SET "print_status" = 'FAILED'
       WHERE "id" = $1 AND "business_id" = $2
       RETURNING id,
                 business_id AS "businessId",
                 table_order_id AS "tableOrderId",
                 table_id AS "tableId",
                 number,
                 type,
                 status,
                 print_status AS "printStatus",
                 print_attempts AS "printAttempts",
                 printed_at AS "printedAt",
                 claimed_by AS "claimedBy",
                 claimed_at AS "claimedAt",
                 created_by AS "createdBy",
                 created_at AS "createdAt",
                 items`,
      roundId,
      businessId,
    );

    if (updated.length === 0) {
      throw new NotFoundException('Ronda no encontrada');
    }

    this.logger.warn(
      `[markPrintFailed] Ronda ${roundId} marcada como FAILED en businessId=${businessId}. Error: ${error || 'sin detalle'}`,
    );

    return updated[0];
  }

  /**
   * Reenvía a PENDING para reimpresión.
   * Deja un logger.warn con quién la pidió.
   */
  async reprint(businessId: string, roundId: string, user: JwtPayload) {
    const updated: any[] = await this.prisma.$queryRawUnsafe(
      `UPDATE "kitchen_rounds"
       SET "print_status" = 'PENDING',
           "claimed_by" = NULL,
           "claimed_at" = NULL
       WHERE "id" = $1 AND "business_id" = $2
       RETURNING id,
                 business_id AS "businessId",
                 table_order_id AS "tableOrderId",
                 table_id AS "tableId",
                 number,
                 type,
                 status,
                 print_status AS "printStatus",
                 print_attempts AS "printAttempts",
                 printed_at AS "printedAt",
                 claimed_by AS "claimedBy",
                 claimed_at AS "claimedAt",
                 created_by AS "createdBy",
                 created_at AS "createdAt",
                 items`,
      roundId,
      businessId,
    );

    if (updated.length === 0) {
      throw new NotFoundException('Ronda no encontrada');
    }

    this.logger.warn(
      `[reprint] Ronda ${roundId} reiniciada a PENDING para reimpresión por usuario ${user.sub} (${user.role}) en businessId=${businessId}`,
    );

    return updated[0];
  }

  /**
   * Obtiene las rondas de la orden activa de una mesa con su print_status.
   */
  async getTableOrderRounds(businessId: string, tableId: string) {
    const order = await this.prisma.tableOrder.findFirst({
      where: {
        tableId,
        businessId,
        status: 'OPEN' as any,
      },
      select: { id: true },
    });

    if (!order) {
      throw new NotFoundException('No hay un pedido abierto para esta mesa');
    }

    const rounds: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT id,
              business_id AS "businessId",
              table_order_id AS "tableOrderId",
              table_id AS "tableId",
              number,
              type,
              status,
              print_status AS "printStatus",
              print_attempts AS "printAttempts",
              printed_at AS "printedAt",
              claimed_by AS "claimedBy",
              claimed_at AS "claimedAt",
              created_by AS "createdBy",
              created_at AS "createdAt",
              items,
              reason,
              authorized_by AS "authorizedBy"
       FROM "kitchen_rounds"
       WHERE "table_order_id" = $1 AND "business_id" = $2
       ORDER BY "number" ASC`,
      order.id,
      businessId,
    );

    return rounds;
  }
}
