import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PosAction } from '../permissions/permissions.service';
import { UpdateExchangeRateDto } from './dto/update-exchange-rate.dto';
import { Prisma } from '@prisma/client';

export const INITIAL_EXCHANGE_RATE = 36.6243;

@Injectable()
export class ExchangeRateService {
  private readonly logger = new Logger(ExchangeRateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  private formatExchangeRate(record: any) {
    if (!record) return null;
    return {
      id: record.id,
      businessId: record.businessId,
      base: record.base,
      quote: record.quote,
      rate: Number(new Prisma.Decimal(record.rate.toString()).toDecimalPlaces(4)),
      source: record.source,
      effectiveFrom: record.effectiveFrom,
      setById: record.setById ?? null,
      createdAt: record.createdAt,
    };
  }

  async getCurrentRate(businessId: string) {
    let latest = await this.prisma.posExchangeRate.findFirst({
      where: { businessId, quote: 'USD' },
      orderBy: { effectiveFrom: 'desc' },
    });

    if (!latest) {
      this.logger.log(`[getCurrentRate] Creando tasa inicial de 36.6243 para negocio=${businessId}`);
      latest = await this.prisma.posExchangeRate.create({
        data: {
          businessId,
          base: 'NIO',
          quote: 'USD',
          rate: new Prisma.Decimal(INITIAL_EXCHANGE_RATE.toString()),
          source: 'OFICIAL',
          effectiveFrom: new Date(),
        },
      });
    }

    return this.formatExchangeRate(latest);
  }

  async updateRate(
    businessId: string,
    dto: UpdateExchangeRateDto,
    userId: string,
    userRole: string,
  ) {
    if (dto.rate < 1 || dto.rate > 1000) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'INVALID_EXCHANGE_RATE',
        message: {
          code: 'INVALID_EXCHANGE_RATE',
          message: 'La tasa de cambio debe estar dentro de un rango razonable (1 a 1000).',
        },
      });
    }

    const current = await this.getCurrentRate(businessId);
    const currentRateNum = current.rate;
    const diffPercent = Math.abs((dto.rate - currentRateNum) / currentRateNum) * 100;

    if (diffPercent > 5 && !dto.confirm) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'CONFIRMATION_REQUIRED',
        message: {
          code: 'CONFIRMATION_REQUIRED',
          message: `El cambio de tasa (${diffPercent.toFixed(2)}%) supera el ±5% respecto a la anterior (${currentRateNum}). Debe enviar confirm: true para confirmar.`,
        },
      });
    }

    const newRecord = await this.prisma.posExchangeRate.create({
      data: {
        businessId,
        base: 'NIO',
        quote: 'USD',
        rate: new Prisma.Decimal(dto.rate.toString()),
        source: 'MANUAL',
        effectiveFrom: new Date(),
        setById: userId,
      },
    });

    await this.auditService.record({
      businessId,
      userId,
      userRole,
      action: PosAction.CAMBIAR_TASA_DOLAR,
      entityType: 'ExchangeRate',
      entityId: newRecord.id,
      before: { rate: currentRateNum },
      after: { rate: Number(new Prisma.Decimal(newRecord.rate.toString()).toDecimalPlaces(4)) },
      reason: 'Actualización manual de tasa de cambio',
    });

    this.logger.log(
      `[updateRate] Tasa actualizada para negocio=${businessId}: antes=${currentRateNum}, ahora=${dto.rate}, por=${userId}`,
    );

    return this.formatExchangeRate(newRecord);
  }

  async getHistory(businessId: string) {
    await this.getCurrentRate(businessId); // Asegura que al menos exista la tasa inicial

    const history = await this.prisma.posExchangeRate.findMany({
      where: { businessId, quote: 'USD' },
      orderBy: { effectiveFrom: 'desc' },
    });

    return history.map((record) => this.formatExchangeRate(record));
  }

  async validateOfflineRate(businessId: string, clientRate: number, occurredAt: Date): Promise<boolean> {
    const msIn7Days = 7 * 24 * 60 * 60 * 1000;
    const minDate = new Date(occurredAt.getTime() - msIn7Days);

    const rates = await this.prisma.posExchangeRate.findMany({
      where: {
        businessId,
        quote: 'USD',
        effectiveFrom: {
          gte: minDate,
        },
      },
    });

    return rates.some((r) => Math.abs(Number(r.rate) - clientRate) < 0.0001);
  }
}
