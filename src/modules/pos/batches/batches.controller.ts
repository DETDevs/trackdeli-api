import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { PosPermissionsGuard } from '../permissions/permissions.guard';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { resolveBusinessId } from '../pos.utils';
import { BatchesService } from './batches.service';
import { GetExpiringBatchesDto } from './dto/get-expiring-batches.dto';
import { UpdateBatchDto } from './dto/update-batch.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard, PosPermissionsGuard)
@Controller('pos/inventory/batches')
export class BatchesController {
  constructor(private readonly batchesService: BatchesService) {}

  /**
   * GET /pos/inventory/batches/expiring?days=30|60|90
   * Reporte y alertas de lotes por vencer / vencidos.
   */
  @Get('expiring')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async getExpiring(
    @CurrentUser() user: JwtPayload,
    @Query() query: GetExpiringBatchesDto,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    const days = query.days ? Number(query.days) : 30;
    return this.batchesService.getExpiringBatches(businessId, days);
  }

  /**
   * PATCH /pos/inventory/batches/:id
   * Modifica batchNumber y/o expiryDate de un lote existente.
   */
  @Patch(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async updateBatch(
    @Param('id') id: string,
    @Body() dto: UpdateBatchDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.batchesService.updateBatch(businessId, id, dto, user.sub, user.role);
  }

  /**
   * GET /pos/inventory/batches?productId=...
   * Lista los lotes de un producto dado.
   */
  @Get()
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
  async getByProduct(
    @Query('productId') productId: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    if (!productId) {
      throw new BadRequestException('El parámetro productId es obligatorio');
    }
    const businessId = resolveBusinessId(user, qBid);
    return this.batchesService.getBatchesByProduct(businessId, productId);
  }
}
