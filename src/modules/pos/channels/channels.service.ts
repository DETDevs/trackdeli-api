import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { UpdateChannelConfigDto } from './dto/update-channel-config.dto';

@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getConfig(businessId: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: {
        id: true,
        name: true,
        taxEnabled: true,
        taxRate: true,
        deliveryChannelEnabled: true,
        pedidosYaChannelEnabled: true,
        deliveryDefaultFee: true,
        deliveryTaxable: true,
        deliveryRequireDriver: true,
        pedidosYaCommissionPct: true,
        pedidosYaTaxPct: true,
        pedidosYaPriceMode: true,
        pedidosYaRounding: true,
        pedidosYaCapAtListPrice: true,
        pedidosYaRequireOrderNumber: true,
      },
    });

    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }

    const deliveryTaxable =
      business.deliveryTaxable !== null && business.deliveryTaxable !== undefined
        ? business.deliveryTaxable
        : Boolean(business.taxEnabled);

    return {
      delivery: {
        enabled: Boolean(business.deliveryChannelEnabled),
        defaultFee: business.deliveryDefaultFee ?? 0,
        taxable: deliveryTaxable,
        requireDriver: Boolean(business.deliveryRequireDriver),
      },
      pedidosYa: {
        enabled: Boolean(business.pedidosYaChannelEnabled),
        commissionPct: business.pedidosYaCommissionPct ?? 27,
        taxPct: business.pedidosYaTaxPct ?? 7,
        priceMode: business.pedidosYaPriceMode || 'MANTENER_GANANCIA',
        rounding: business.pedidosYaRounding || 'REDONDEO_1',
        capAtListPrice: Boolean(business.pedidosYaCapAtListPrice),
        requireOrderNumber: business.pedidosYaRequireOrderNumber !== false,
      },
    };
  }

  async updateConfig(
    businessId: string,
    dto: UpdateChannelConfigDto,
    role?: string,
    userId?: string,
  ) {
    if (role && role !== UserRole.ENCARGADO && role !== UserRole.SUPERADMIN) {
      throw new ForbiddenException(
        'Solo el Encargado o Superadmin pueden modificar la configuración de canales de venta',
      );
    }

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, taxEnabled: true },
    });

    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }

    const dataToUpdate: any = {};

    // 1. A Domicilio
    const deliveryInput = dto.delivery;
    if (deliveryInput?.defaultFee !== undefined) {
      dataToUpdate.deliveryDefaultFee = Math.max(0, Number(deliveryInput.defaultFee));
    } else if (dto.deliveryDefaultFee !== undefined) {
      dataToUpdate.deliveryDefaultFee = Math.max(0, Number(dto.deliveryDefaultFee));
    }

    if (deliveryInput?.taxable !== undefined) {
      dataToUpdate.deliveryTaxable = deliveryInput.taxable;
    } else if (dto.deliveryTaxable !== undefined) {
      dataToUpdate.deliveryTaxable = dto.deliveryTaxable;
    }

    if (deliveryInput?.requireDriver !== undefined) {
      dataToUpdate.deliveryRequireDriver = Boolean(deliveryInput.requireDriver);
    } else if (dto.deliveryRequireDriver !== undefined) {
      dataToUpdate.deliveryRequireDriver = Boolean(dto.deliveryRequireDriver);
    }

    // 2. PedidosYa
    const pYaInput = dto.pedidosYa;
    const commPct = pYaInput?.commissionPct !== undefined ? pYaInput.commissionPct : dto.pedidosYaCommissionPct;
    if (commPct !== undefined) {
      if (commPct < 0 || commPct > 100) {
        throw new BadRequestException('La comisión de PedidosYa debe estar entre 0 y 100%');
      }
      dataToUpdate.pedidosYaCommissionPct = Number(commPct);
    }

    const taxPct = pYaInput?.taxPct !== undefined ? pYaInput.taxPct : dto.pedidosYaTaxPct;
    if (taxPct !== undefined) {
      if (taxPct < 0 || taxPct > 100) {
        throw new BadRequestException('El impuesto sobre comisión de PedidosYa debe estar entre 0 y 100%');
      }
      dataToUpdate.pedidosYaTaxPct = Number(taxPct);
    }

    const priceMode = pYaInput?.priceMode || dto.pedidosYaPriceMode;
    if (priceMode !== undefined) {
      if (!['RECARGO', 'MANTENER_GANANCIA', 'MISMO_PRECIO'].includes(priceMode)) {
        throw new BadRequestException(
          'Modo de precio inválido. Opciones permitidas: RECARGO, MANTENER_GANANCIA, MISMO_PRECIO',
        );
      }
      dataToUpdate.pedidosYaPriceMode = priceMode;
    }

    const rounding = pYaInput?.rounding || dto.pedidosYaRounding;
    if (rounding !== undefined) {
      if (!['SIN_REDONDEO', 'REDONDEO_0_50', 'REDONDEO_1', 'REDONDEO_5'].includes(rounding)) {
        throw new BadRequestException(
          'Modo de redondeo inválido. Opciones permitidas: SIN_REDONDEO, REDONDEO_0_50, REDONDEO_1, REDONDEO_5',
        );
      }
      dataToUpdate.pedidosYaRounding = rounding;
    }

    const capAtListPrice = pYaInput?.capAtListPrice !== undefined ? pYaInput.capAtListPrice : dto.pedidosYaCapAtListPrice;
    if (capAtListPrice !== undefined) {
      dataToUpdate.pedidosYaCapAtListPrice = Boolean(capAtListPrice);
    }

    const requireOrderNumber = pYaInput?.requireOrderNumber !== undefined ? pYaInput.requireOrderNumber : dto.pedidosYaRequireOrderNumber;
    if (requireOrderNumber !== undefined) {
      dataToUpdate.pedidosYaRequireOrderNumber = Boolean(requireOrderNumber);
    }

    if (Object.keys(dataToUpdate).length > 0) {
      await this.prisma.business.update({
        where: { id: businessId },
        data: dataToUpdate,
      });
      this.logger.log(
        `[updateConfig] Canales actualizados para negocio ${businessId} por usuario ${userId || 'SYSTEM'}: ${JSON.stringify(dataToUpdate)}`,
      );
    }

    return this.getConfig(businessId);
  }

  async listDrivers(businessId: string) {
    const drivers = await this.prisma.user.findMany({
      where: {
        businessId,
        role: UserRole.REPARTIDOR,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        vehicleType: true,
        vehiclePlate: true,
        isActive: true,
      },
      orderBy: { name: 'asc' },
    });

    return drivers;
  }
}
