import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { resolveBusinessId } from '../pos.utils';
import { PrintAuditService } from './print-audit.service';
import { UpdateReceiptSettingsDto } from './dto/update-receipt-settings.dto';

@Controller('pos/receipt-settings')
@UseGuards(JwtAuthGuard, PosGuard, RolesGuard)
export class ReceiptSettingsController {
  constructor(private readonly service: PrintAuditService) {}

  /**
   * Obtiene la configuración del ticket por negocio.
   * Si no existe fila, devuelve los valores por defecto del ticket actual sin crear fila.
   * Accesible para cualquier rol POS.
   */
  @Get()
  @Roles(
    UserRole.CAJERO,
    UserRole.ENCARGADO,
    UserRole.SUPERADMIN,
    UserRole.WAITER,
    UserRole.REPARTIDOR,
  )
  getSettings(@CurrentUser() user: JwtPayload, @Query('businessId') qBid?: string) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.getReceiptSettings(businessId);
  }

  /**
   * Actualiza o crea la configuración del ticket.
   * Exclusivo de ENCARGADO y SUPERADMIN.
   */
  @Put()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  updateSettings(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateReceiptSettingsDto,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.updateReceiptSettings(businessId, user.sub, dto);
  }
}
