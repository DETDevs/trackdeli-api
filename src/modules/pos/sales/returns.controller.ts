import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { PosPermissionsGuard } from '../permissions/permissions.guard';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { resolveBusinessId } from '../pos.utils';
import { SalesService } from './sales.service';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard, PosPermissionsGuard)
@Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
@Controller('pos/returns')
export class ReturnsController {
  constructor(private readonly salesService: SalesService) {}

  @Get()
  findReturns(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('userId') userId?: string,
    @Query('reason') reason?: string,
    @Query('saleId') saleId?: string,
  ) {
    return this.salesService.findReturns(resolveBusinessId(user, qBid), {
      from,
      to,
      userId,
      reason,
      saleId,
    });
  }
}
