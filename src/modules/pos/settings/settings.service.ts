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
        id: true, name: true, hasPOS: true, hasTrackDeli: true, hasCarteraCobro: true, hasCitas: true,
        posVertical: true, gridColumns: true, gridRows: true,
        taxRate: true, currency: true, invoicePrefix: true, invoiceCounter: true,
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

  async updateSettings(businessId: string, dto: UpdatePosSettingsDto) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId }, select: { id: true } });
    if (!business) throw new NotFoundException("Negocio no encontrado");
    this.logger.log(`[updateSettings] businessId=${businessId}`);

    if (dto.posVertical !== undefined) {
      await this.prisma.$transaction(async (tx) => {

        await tx.business.update({
          where: { id: businessId },
          data: dto,
          select: { id: true },
        });

        await tx.businessProductSubscription.updateMany({
          where: { businessId, productType: 'POS' },
          data: { posVertical: dto.posVertical },
        });
      });

      this.logger.log(`[updateSettings] posVertical actualizado en business y suscripción POS: ${dto.posVertical}`);
    } else {

      await this.prisma.business.update({
        where: { id: businessId },
        data: dto,
        select: { id: true },
      });
    }

    return this.getSettings(businessId);
  }
}

