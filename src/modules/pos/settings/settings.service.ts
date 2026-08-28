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
        taxRate: true, currency: true, invoicePrefix: true, invoiceCounter: true,
        posAddress: true, posPhone: true, posFooter: true,
      },
    });
    if (!business) throw new NotFoundException("Negocio no encontrado");
    return business;
  }

  async updateSettings(businessId: string, dto: UpdatePosSettingsDto) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId }, select: { id: true } });
    if (!business) throw new NotFoundException("Negocio no encontrado");
    this.logger.log(`[updateSettings] businessId=${businessId}`);
    return this.prisma.business.update({
      where: { id: businessId },
      data: dto,
      select: {
        id: true, name: true, hasPOS: true, hasTrackDeli: true,
        taxRate: true, currency: true, invoicePrefix: true, invoiceCounter: true,
        posAddress: true, posPhone: true, posFooter: true,
      },
    });
  }
}
