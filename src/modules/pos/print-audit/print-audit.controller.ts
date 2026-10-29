import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { resolveBusinessId } from '../pos.utils';
import { PrintAuditService } from './print-audit.service';
import { BatchPrintEventsDto, CreatePrintEventDto } from './dto/create-print-event.dto';
import { GetPrintCountsDto } from './dto/get-counts.dto';

@Controller('pos/print-audit')
@UseGuards(JwtAuthGuard, PosGuard, RolesGuard)
export class PrintAuditController {
  constructor(private readonly service: PrintAuditService) {}

  /**
   * Registra un lote de eventos de impresión/compartir (máx. 200).
   * Cualquier rol POS autenticado puede registrar los suyos.
   */
  @Post('events')
  @Roles(
    UserRole.CAJERO,
    UserRole.ENCARGADO,
    UserRole.SUPERADMIN,
    UserRole.WAITER,
    UserRole.REPARTIDOR,
    UserRole.VENDEDOR,
  )
  registerEvents(
    @CurrentUser() user: JwtPayload,
    @Body() body: BatchPrintEventsDto | CreatePrintEventDto[],
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    const events = Array.isArray(body) ? body : body?.events || [];
    return this.service.registerEvents(businessId, user.sub, events, user.role);
  }

  /**
   * Obtiene la auditoría de un documento específico.
   */
  @Get('document/:documentType/:documentId')
  @Roles(
    UserRole.CAJERO,
    UserRole.ENCARGADO,
    UserRole.SUPERADMIN,
    UserRole.WAITER,
    UserRole.REPARTIDOR,
  )
  getDocumentAudit(
    @CurrentUser() user: JwtPayload,
    @Param('documentType') documentType: string,
    @Param('documentId') documentId: string,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.getDocumentAudit(businessId, documentType, documentId);
  }

  /**
   * Mapa de conteos para múltiples documentos (para insignias en listas).
   */
  @Post('counts')
  @Roles(
    UserRole.CAJERO,
    UserRole.ENCARGADO,
    UserRole.SUPERADMIN,
    UserRole.WAITER,
    UserRole.REPARTIDOR,
  )
  getCounts(
    @CurrentUser() user: JwtPayload,
    @Body() dto: GetPrintCountsDto,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.getCounts(businessId, dto.documentType, dto.ids);
  }

  /**
   * Reporte de auditoría de impresiones. Solo ENCARGADO y SUPERADMIN.
   */
  @Get('report')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  getReport(
    @CurrentUser() user: JwtPayload,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('period') period?: string,
    @Query('documentType') documentType?: string,
    @Query('userId') userId?: string,
    @Query('minReprints') minReprints?: string,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.getReport(businessId, {
      from,
      to,
      period,
      documentType,
      userId,
      minReprints,
    });
  }
}
