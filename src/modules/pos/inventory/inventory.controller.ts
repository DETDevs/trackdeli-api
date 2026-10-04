import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { PosPermissionsGuard } from '../permissions/permissions.guard';
import { RequirePosAction } from '../permissions/require-action.decorator';
import { PosAction } from '../permissions/permissions.service';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { resolveBusinessId } from '../pos.utils';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor';
import { InventoryService } from './inventory.service';
import { CreateAdjustmentDto } from './dto/create-adjustment.dto';
import { BatchCountDto } from './dto/batch-count.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard, PosPermissionsGuard)
@Controller('pos/inventory')
export class InventoryController {
  constructor(private readonly service: InventoryService) {}

  @Post('adjustments')
  @RequirePosAction(PosAction.AJUSTE_INVENTARIO)
  @UseInterceptors(IdempotencyInterceptor)
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
  createAdjustment(
    @Body() dto: CreateAdjustmentDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.createAdjustment(
      dto,
      resolveBusinessId(user, qBid),
      user.sub,
      user.role,
    );
  }

  @Post('counts')
  @RequirePosAction(PosAction.AJUSTE_INVENTARIO)
  @UseInterceptors(IdempotencyInterceptor)
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  batchCount(
    @Body() dto: BatchCountDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.batchCount(
      dto,
      resolveBusinessId(user, qBid),
      user.sub,
      user.role,
    );
  }

  @Get('adjustments')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  findAllAdjustments(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
    @Query('productId') productId?: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.service.findAllAdjustments(resolveBusinessId(user, qBid), {
      productId,
      type,
      from,
      to,
      page,
      limit,
    });
  }

  @Get('adjustments/:id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  findOneAdjustment(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.findOneAdjustment(id, resolveBusinessId(user, qBid));
  }
}
