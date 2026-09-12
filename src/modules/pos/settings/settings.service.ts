import { Injectable, NotFoundException, Logger } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { UpdatePosSettingsDto } from "./dto/update-pos-settings.dto";

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getSettings(businessId: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: {
        id: true, name: true, hasPOS: true, hasTrackDeli: true,
        posVertical: true, gridColumns: true, gridRows: true,
        taxRate: true, currency: true, invoicePrefix: true, invoiceCounter: true,
        posAddress: true, posPhone: true, posFooter: true,
        productSubscriptions: {
          where: { productType: 'POS' },
          select: { posVertical: true },
          take: 1,
        },
      },
    });
    if (!business) throw new NotFoundException("Negocio no encontrado");

    // Fuente de verdad: suscripción POS. Fallback: campo legacy Business.posVertical
    const posSub = business.productSubscriptions?.[0];
    const resolvedPosVertical = posSub?.posVertical ?? business.posVertical;

    const { productSubscriptions, ...businessData } = business;
    return {
      ...businessData,
      posVertical: resolvedPosVertical,
    };
  }

  async updateSettings(businessId: string, dto: UpdatePosSettingsDto) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId }, select: { id: true } });
    if (!business) throw new NotFoundException("Negocio no encontrado");
    this.logger.log(`[updateSettings] businessId=${businessId}`);

    // Si el DTO incluye posVertical, escribir en ambos lados de forma atómica
    if (dto.posVertical !== undefined) {
      await this.prisma.$transaction(async (tx) => {
        // 1. Actualizar campo legacy en Business
        await tx.business.update({
          where: { id: businessId },
          data: dto,
          select: { id: true },
        });

        // 2. Actualizar fuente de verdad en BusinessProductSubscription
        await tx.businessProductSubscription.updateMany({
          where: { businessId, productType: 'POS' },
          data: { posVertical: dto.posVertical },
        });
      });

      this.logger.log(`[updateSettings] posVertical actualizado en business y suscripción POS: ${dto.posVertical}`);
    } else {
      // Sin posVertical en el DTO — actualización normal solo en Business
      await this.prisma.business.update({
        where: { id: businessId },
        data: dto,
        select: { id: true },
      });
    }

    // Devolver el estado actualizado mediante getSettings (ya resuelve la fuente de verdad)
    return this.getSettings(businessId);
  }
}
