import { Injectable, NotFoundException, Logger, ForbiddenException } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { UpdatePosSettingsDto } from "./dto/update-pos-settings.dto";
import { UserRole } from "@prisma/client";

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getSettings(businessId: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: {
        id: true, name: true, hasPOS: true, hasTrackDeli: true, hasCarteraCobro: true, hasCitas: true,
        posVertical: true, gridColumns: true, gridRows: true,
        taxRate: true, taxEnabled: true, taxIncluded: true, currency: true, invoicePrefix: true, invoiceCounter: true,
        posAddress: true, posPhone: true, posFooter: true,
        productSubscriptions: {
          where: { productType: { in: ['POS', 'CARTERA_COBRO', 'CITAS'] } },
          select: { productType: true, posVertical: true, status: true },
        },
      },
    });
    if (!business) throw new NotFoundException("Negocio no encontrado");

    const posSub = business.productSubscriptions?.find((s) => s.productType === 'POS');
    const carteraSub = business.productSubscriptions?.find((s) => s.productType === 'CARTERA_COBRO');
    const resolvedPosVertical = posSub?.posVertical ?? business.posVertical;
    const isCarteraCobroActive = carteraSub ? carteraSub.status === 'ACTIVE' : Boolean(business.hasCarteraCobro);
    const citasSub = business.productSubscriptions?.find((s) => s.productType === 'CITAS');
    const isCitasActive = citasSub ? citasSub.status === 'ACTIVE' : Boolean((business as any).hasCitas);

    const { productSubscriptions, ...businessData } = business;
    return {
      ...businessData,
      hasCarteraCobro: isCarteraCobroActive,
      hasCitas: isCitasActive,
      posVertical: resolvedPosVertical,
    };
  }

  async updateSettings(businessId: string, dto: UpdatePosSettingsDto, role: UserRole, userId: string) {
    const business = await this.prisma.business.findUnique({ 
      where: { id: businessId }, 
      select: { id: true, taxRate: true, taxEnabled: true, taxIncluded: true, invoicePrefix: true, posAddress: true, posPhone: true, posFooter: true } 
    });
    if (!business) throw new NotFoundException("Negocio no encontrado");
    this.logger.log(`[updateSettings] businessId=${businessId}, role=${role}`);

    const businessFields: (keyof UpdatePosSettingsDto)[] = [
      'taxRate', 'taxEnabled', 'taxIncluded', 'invoicePrefix', 'posAddress', 'posPhone', 'posFooter', 'posVertical', 'gridColumns', 'gridRows'
    ];

    const hasBusinessFields = businessFields.some(field => dto[field] !== undefined);

    if (hasBusinessFields && role !== UserRole.ENCARGADO && role !== UserRole.SUPERADMIN) {
      throw new ForbiddenException("No tienes permisos para modificar la configuración global del negocio. Solo el Encargado puede hacerlo.");
    }

    if (Object.keys(dto).length === 0) {
      return this.getSettings(businessId);
    }

    // Actualización parcial y Auditoría
    const dataToUpdate: any = {};
    for (const field of businessFields) {
      if (dto[field] !== undefined) {
        dataToUpdate[field] = dto[field];
        
        // Audit log para campos sensibles
        if (['taxRate', 'taxEnabled', 'taxIncluded', 'invoicePrefix', 'posFooter'].includes(field)) {
          const oldVal = (business as any)[field];
          if (oldVal !== dto[field]) {
            this.logger.log(`[AUDIT] Settings cambiado por usuario ${userId}: ${field} cambió de "${oldVal}" a "${dto[field]}"`);
          }
        }
      }
    }

    if (Object.keys(dataToUpdate).length > 0) {
      if (dataToUpdate.posVertical !== undefined) {
        await this.prisma.$transaction(async (tx) => {
          await tx.business.update({
            where: { id: businessId },
            data: dataToUpdate,
            select: { id: true },
          });

          await tx.businessProductSubscription.updateMany({
            where: { businessId, productType: 'POS' },
            data: { posVertical: dataToUpdate.posVertical },
          });
        });
        this.logger.log(`[updateSettings] posVertical actualizado en business y suscripción POS: ${dataToUpdate.posVertical}`);
      } else {
        await this.prisma.business.update({
          where: { id: businessId },
          data: dataToUpdate,
          select: { id: true },
        });
      }
    }

    return this.getSettings(businessId);
  }
}

