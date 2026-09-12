import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  BusinessProductAction,
  BusinessProductStatus,
  BusinessProductType,
  CashStatus,
  DispatchStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ACTIVE_ORDER_STATUSES } from '../../common/constants/orders.constants';
import { ActivateProductDto } from './dto/activate-product.dto';
import { DeactivateProductDto } from './dto/deactivate-product.dto';

@Injectable()
export class BusinessProductsService {
  private readonly logger = new Logger(BusinessProductsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ==========================================
  // 1. MÉTODO PÚBLICO / REUTILIZABLE (GUARDS Y SERVICIOS)
  // ==========================================

  /**
   * Verifica si un producto específico (DELIVERY o POS) está activo para un negocio.
   * Única fuente de verdad reutilizable por PosGuard, OrdersService, DispatchService, etc.
   */
  async isActive(businessId: string, productType: BusinessProductType): Promise<boolean> {
    if (!businessId) return false;

    const subscription = await this.prisma.businessProductSubscription.findUnique({
      where: {
        businessId_productType: { businessId, productType },
      },
      select: { status: true },
    });

    return subscription?.status === BusinessProductStatus.ACTIVE;
  }

  // ==========================================
  // 2. CONSULTA DE PRODUCTOS Y AUDITORÍA
  // ==========================================

  /**
   * Devuelve el estado actual de AMBOS productos (DELIVERY y POS) para el negocio.
   */
  async getProducts(businessId: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      include: {
        productSubscriptions: true,
      },
    });

    if (!business) {
      throw new NotFoundException(`Negocio con ID "${businessId}" no encontrado`);
    }

    const deliverySub = business.productSubscriptions.find(
      (s) => s.productType === BusinessProductType.DELIVERY,
    );
    const posSub = business.productSubscriptions.find(
      (s) => s.productType === BusinessProductType.POS,
    );

    return {
      businessId: business.id,
      businessName: business.name,
      products: {
        DELIVERY: deliverySub
          ? {
              id: deliverySub.id,
              productType: deliverySub.productType,
              status: deliverySub.status,
              commissionRate: deliverySub.commissionRate
                ? Number(deliverySub.commissionRate)
                : business.commissionRate,
              altCommissionRate: deliverySub.altCommissionRate
                ? Number(deliverySub.altCommissionRate)
                : business.altCommissionRate,
              altCommissionDistanceKm: deliverySub.altCommissionDistanceKm
                ? Number(deliverySub.altCommissionDistanceKm)
                : business.altCommissionDistanceKm,
              dispatchTimeoutMin:
                deliverySub.dispatchTimeoutMin ?? business.dispatchTimeoutMin,
              activatedAt: deliverySub.activatedAt,
              activatedBy: deliverySub.activatedBy,
              deactivatedAt: deliverySub.deactivatedAt,
              deactivatedBy: deliverySub.deactivatedBy,
              createdAt: deliverySub.createdAt,
              updatedAt: deliverySub.updatedAt,
            }
          : {
              productType: BusinessProductType.DELIVERY,
              status: BusinessProductStatus.INACTIVE,
              commissionRate: business.commissionRate,
              altCommissionRate: business.altCommissionRate,
              altCommissionDistanceKm: business.altCommissionDistanceKm,
              dispatchTimeoutMin: business.dispatchTimeoutMin,
              activatedAt: null,
              activatedBy: null,
              deactivatedAt: null,
              deactivatedBy: null,
            },
        POS: posSub
          ? {
              id: posSub.id,
              productType: posSub.productType,
              status: posSub.status,
              posVertical: posSub.posVertical ?? business.posVertical,
              posMonthlyFee: posSub.posMonthlyFee ? Number(posSub.posMonthlyFee) : null,
              activatedAt: posSub.activatedAt,
              activatedBy: posSub.activatedBy,
              deactivatedAt: posSub.deactivatedAt,
              deactivatedBy: posSub.deactivatedBy,
              createdAt: posSub.createdAt,
              updatedAt: posSub.updatedAt,
            }
          : {
              productType: BusinessProductType.POS,
              status: business.hasPOS
                ? BusinessProductStatus.ACTIVE
                : BusinessProductStatus.INACTIVE,
              posVertical: business.posVertical,
              posMonthlyFee: null,
              activatedAt: null,
              activatedBy: null,
              deactivatedAt: null,
              deactivatedBy: null,
            },
      },
    };
  }

  /**
   * Consulta el log de auditoría completo de un producto en un negocio, ordenado por fecha desc.
   */
  async getAuditLog(businessId: string, productType: BusinessProductType) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true },
    });

    if (!business) {
      throw new NotFoundException(`Negocio con ID "${businessId}" no encontrado`);
    }

    return this.prisma.businessProductAuditLog.findMany({
      where: { businessId, productType },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ==========================================
  // 3. ACTIVACIÓN DE PRODUCTO (IDEMPOTENTE Y SERIALIZABLE)
  // ==========================================

  async activateProduct(
    businessId: string,
    productType: BusinessProductType,
    dto: ActivateProductDto,
    superAdminId: string,
  ) {
    return this.runWithSerializableRetry(
      'activate',
      businessId,
      productType,
      async (tx) => {
        const business = await tx.business.findUnique({
          where: { id: businessId },
        });
        if (!business) {
          throw new NotFoundException(`Negocio con ID "${businessId}" no encontrado`);
        }

        const existingSub = await tx.businessProductSubscription.findUnique({
          where: {
            businessId_productType: { businessId, productType },
          },
        });

        const isAlreadyActive = existingSub?.status === BusinessProductStatus.ACTIVE;

        // Construir datos de configuración según el tipo de producto
        const deliveryConfig =
          productType === BusinessProductType.DELIVERY
            ? {
                commissionRate:
                  dto.commissionRate !== undefined
                    ? new Prisma.Decimal(dto.commissionRate)
                    : (existingSub?.commissionRate ?? new Prisma.Decimal(business.commissionRate)),
                altCommissionRate:
                  dto.altCommissionRate !== undefined
                    ? new Prisma.Decimal(dto.altCommissionRate)
                    : (existingSub?.altCommissionRate ??
                      new Prisma.Decimal(business.altCommissionRate)),
                altCommissionDistanceKm:
                  dto.altCommissionDistanceKm !== undefined
                    ? new Prisma.Decimal(dto.altCommissionDistanceKm)
                    : (existingSub?.altCommissionDistanceKm ??
                      new Prisma.Decimal(business.altCommissionDistanceKm)),
                dispatchTimeoutMin:
                  dto.dispatchTimeoutMin !== undefined
                    ? dto.dispatchTimeoutMin
                    : (existingSub?.dispatchTimeoutMin ?? business.dispatchTimeoutMin),
              }
            : {};

        const posConfig =
          productType === BusinessProductType.POS
            ? {
                posVertical:
                  dto.posVertical !== undefined
                    ? dto.posVertical
                    : (existingSub?.posVertical ?? business.posVertical),
                posMonthlyFee:
                  dto.posMonthlyFee !== undefined
                    ? new Prisma.Decimal(dto.posMonthlyFee)
                    : (existingSub?.posMonthlyFee ?? null),
              }
            : {};

        if (isAlreadyActive) {
          // Idempotente: confirmar estado y actualizar configuración
          const updatedSub = await tx.businessProductSubscription.update({
            where: { id: existingSub.id },
            data: {
              ...deliveryConfig,
              ...posConfig,
            },
          });

          // Registrar en auditoría como CONFIG_UPDATED
          await tx.businessProductAuditLog.create({
            data: {
              businessId,
              productType,
              action: BusinessProductAction.CONFIG_UPDATED,
              performedBy: superAdminId,
              reason: dto.reason || 'Actualización de configuración en producto activo',
              metadata: {
                previousConfig: {
                  commissionRate: existingSub.commissionRate
                    ? Number(existingSub.commissionRate)
                    : null,
                  posVertical: existingSub.posVertical,
                  posMonthlyFee: existingSub.posMonthlyFee
                    ? Number(existingSub.posMonthlyFee)
                    : null,
                },
                newConfig: {
                  ...dto,
                },
              },
            },
          });

          // Sincronizar campos legacy en Business como fallback
          await this.syncLegacyBusinessFields(tx, businessId, productType, true, dto);

          this.logger.log(
            `[BusinessProductsService] [activate] businessId=${businessId} productType=${productType} by=${superAdminId} result=IDEMPOTENT`,
          );

          return {
            status: 'ACTIVE',
            isIdempotent: true,
            message: `El producto ${productType} ya estaba activo. Configuración confirmada y actualizada.`,
            subscription: updatedSub,
          };
        }

        // Nueva activación o reactivación
        const upsertedSub = await tx.businessProductSubscription.upsert({
          where: {
            businessId_productType: { businessId, productType },
          },
          update: {
            status: BusinessProductStatus.ACTIVE,
            activatedAt: new Date(),
            activatedBy: superAdminId,
            deactivatedAt: null,
            deactivatedBy: null,
            ...deliveryConfig,
            ...posConfig,
          },
          create: {
            businessId,
            productType,
            status: BusinessProductStatus.ACTIVE,
            activatedAt: new Date(),
            activatedBy: superAdminId,
            deactivatedAt: null,
            deactivatedBy: null,
            ...deliveryConfig,
            ...posConfig,
          },
        });

        // Registrar en auditoría como ACTIVATED
        await tx.businessProductAuditLog.create({
          data: {
            businessId,
            productType,
            action: BusinessProductAction.ACTIVATED,
            performedBy: superAdminId,
            reason: dto.reason || 'Activación de producto',
            metadata: {
              config: {
                ...dto,
              },
            },
          },
        });

        // Sincronizar campos legacy en Business como fallback
        await this.syncLegacyBusinessFields(tx, businessId, productType, true, dto);

        this.logger.log(
          `[BusinessProductsService] [activate] businessId=${businessId} productType=${productType} by=${superAdminId} result=OK`,
        );

        return {
          status: 'ACTIVE',
          isIdempotent: false,
          message: `Producto ${productType} activado exitosamente`,
          subscription: upsertedSub,
        };
      },
    );
  }

  // ==========================================
  // 4. DESACTIVACIÓN DE PRODUCTO (CON BLOQUEO Y FORCE)
  // ==========================================

  async deactivateProduct(
    businessId: string,
    productType: BusinessProductType,
    dto: DeactivateProductDto,
    force: boolean,
    superAdminId: string,
  ) {
    return this.runWithSerializableRetry(
      'deactivate',
      businessId,
      productType,
      async (tx) => {
        const business = await tx.business.findUnique({
          where: { id: businessId },
        });
        if (!business) {
          throw new NotFoundException(`Negocio con ID "${businessId}" no encontrado`);
        }

        const existingSub = await tx.businessProductSubscription.findUnique({
          where: {
            businessId_productType: { businessId, productType },
          },
        });

        if (!existingSub || existingSub.status === BusinessProductStatus.INACTIVE) {
          return {
            status: 'INACTIVE',
            isIdempotent: true,
            message: `El producto ${productType} ya se encuentra inactivo`,
            subscription: existingSub,
          };
        }

        // Verificar operaciones en curso que impiden desactivación
        let hasPendingOperations = false;
        const details: any = { productType };

        if (productType === BusinessProductType.DELIVERY) {
          const activeOrdersCount = await tx.order.count({
            where: {
              businessId,
              status: { in: ACTIVE_ORDER_STATUSES },
            },
          });

          const activeDispatchesCount = await tx.orderDispatch.count({
            where: {
              order: { businessId },
              status: DispatchStatus.SENT,
              timeoutAt: { gt: new Date() },
            },
          });

          details.activeOrders = activeOrdersCount;
          details.activeDispatches = activeDispatchesCount;

          if (activeOrdersCount > 0 || activeDispatchesCount > 0) {
            hasPendingOperations = true;
          }
        } else if (productType === BusinessProductType.POS) {
          const openCashRegistersCount = await tx.cashRegister.count({
            where: {
              businessId,
              status: CashStatus.OPEN,
            },
          });

          details.openCashRegisters = openCashRegistersCount;

          if (openCashRegistersCount > 0) {
            hasPendingOperations = true;
          }
        }

        // CASO 1: Operaciones en curso SIN force -> BLOQUEAR con 409 Conflict
        if (hasPendingOperations && !force) {
          const reasonMsg =
            productType === BusinessProductType.DELIVERY
              ? `${details.activeOrders} pedidos activos, ${details.activeDispatches} despachos en curso`
              : `${details.openCashRegisters} caja(s) registradora(s) abierta(s)`;

          // Se persiste con this.prisma para que no se pierda en el rollback al lanzar ConflictException
          await this.prisma.businessProductAuditLog.create({
            data: {
              businessId,
              productType,
              action: BusinessProductAction.DEACTIVATION_BLOCKED,
              performedBy: superAdminId,
              reason: dto.reason || 'Desactivación bloqueada por operaciones en curso',
              metadata: details,
            },
          });

          this.logger.warn(
            `[BusinessProductsService] [deactivate] BLOCKED businessId=${businessId} productType=${productType} reason="${reasonMsg}"`,
          );

          throw new ConflictException({
            statusCode: 409,
            message: `No se puede desactivar ${productType} porque tiene operaciones en curso (${reasonMsg}). Requiere confirmación con ?force=true`,
            error: 'Conflict',
            details,
          });
        }

        // CASO 2: Operaciones en curso CON force -> DESACTIVACIÓN FORZADA
        if (hasPendingOperations && force) {
          const deactivatedSub = await tx.businessProductSubscription.update({
            where: { id: existingSub.id },
            data: {
              status: BusinessProductStatus.INACTIVE,
              deactivatedAt: new Date(),
              deactivatedBy: superAdminId,
            },
          });

          await tx.businessProductAuditLog.create({
            data: {
              businessId,
              productType,
              action: BusinessProductAction.DEACTIVATION_FORCED,
              performedBy: superAdminId,
              reason: dto.reason || 'Desactivación forzada por SuperAdmin',
              metadata: {
                forcedWithPendingOperations: true,
                ...details,
              },
            },
          });

          await this.syncLegacyBusinessFields(tx, businessId, productType, false);

          this.logger.warn(
            `[BusinessProductsService] [deactivate] FORCED businessId=${businessId} productType=${productType} by=${superAdminId} details="${JSON.stringify(details)}"`,
          );

          return {
            status: 'INACTIVE',
            forced: true,
            message: `Producto ${productType} desactivado de forma forzada por SuperAdmin.`,
            warning:
              productType === BusinessProductType.DELIVERY
                ? 'Los pedidos en curso continuarán normalmente su entrega, pero no se podrán crear nuevos pedidos.'
                : 'Las cajas registradoras abiertas no fueron cerradas automáticamente y deberán cerrarse de forma manual.',
            details,
            subscription: deactivatedSub,
          };
        }

        // CASO 3: Sin operaciones en curso -> DESACTIVACIÓN LIMPIA
        const deactivatedSub = await tx.businessProductSubscription.update({
          where: { id: existingSub.id },
          data: {
            status: BusinessProductStatus.INACTIVE,
            deactivatedAt: new Date(),
            deactivatedBy: superAdminId,
          },
        });

        await tx.businessProductAuditLog.create({
          data: {
            businessId,
            productType,
            action: BusinessProductAction.DEACTIVATED,
            performedBy: superAdminId,
            reason: dto.reason || 'Desactivación estándar de producto',
            metadata: details,
          },
        });

        await this.syncLegacyBusinessFields(tx, businessId, productType, false);

        this.logger.log(
          `[BusinessProductsService] [deactivate] OK businessId=${businessId} productType=${productType} by=${superAdminId}`,
        );

        return {
          status: 'INACTIVE',
          forced: false,
          message: `Producto ${productType} desactivado exitosamente`,
          subscription: deactivatedSub,
        };
      },
    );
  }

  // ==========================================
  // HELPERS: CONCURRENCIA SERIALIZABLE Y LEGACY SYNC
  // ==========================================

  /**
   * Ejecuta una transacción con nivel de aislamiento Serializable.
   * Si ocurre un conflicto de escritura concurrente (P2034), reintenta automáticamente hasta 3 veces con backoff.
   */
  private async runWithSerializableRetry<T>(
    operationName: string,
    businessId: string,
    productType: BusinessProductType,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const maxRetries = 3;
    const backoffs = [100, 300, 600];

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.prisma.$transaction(fn, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error: any) {
        if (error?.code === 'P2034' && attempt < maxRetries) {
          this.logger.warn(
            `[BusinessProductsService] Write conflict detected, retrying... businessId=${businessId} productType=${productType} attempt=${attempt}`,
          );
          await new Promise((resolve) => setTimeout(resolve, backoffs[attempt - 1]));
          continue;
        }
        throw error;
      }
    }

    throw new ConflictException(
      `Conflicto de concurrencia al procesar ${operationName} en ${productType}. Por favor reintente.`,
    );
  }

  /**
   * Sincroniza campos legacy en el modelo Business como fallback para compatibilidad con código existente.
   */
  private async syncLegacyBusinessFields(
    tx: Prisma.TransactionClient,
    businessId: string,
    productType: BusinessProductType,
    isActive: boolean,
    dto?: ActivateProductDto,
  ) {
    if (productType === BusinessProductType.POS) {
      await tx.business.update({
        where: { id: businessId },
        data: {
          hasPOS: isActive,
          ...(isActive && dto?.posVertical && { posVertical: dto.posVertical }),
        },
      });
    } else if (productType === BusinessProductType.DELIVERY) {
      await tx.business.update({
        where: { id: businessId },
        data: {
          hasTrackDeli: isActive,
          ...(isActive &&
            dto?.commissionRate !== undefined && { commissionRate: dto.commissionRate }),
          ...(isActive &&
            dto?.altCommissionRate !== undefined && {
              altCommissionRate: dto.altCommissionRate,
            }),
          ...(isActive &&
            dto?.altCommissionDistanceKm !== undefined && {
              altCommissionDistanceKm: dto.altCommissionDistanceKm,
            }),
          ...(isActive &&
            dto?.dispatchTimeoutMin !== undefined && {
              dispatchTimeoutMin: dto.dispatchTimeoutMin,
            }),
        },
      });
    }
  }
}
