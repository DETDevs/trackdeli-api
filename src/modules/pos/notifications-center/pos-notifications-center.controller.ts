import { Controller, ForbiddenException, Get, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { resolveBusinessId } from '../pos.utils';
import { PosNotificationsCenterService } from './pos-notifications-center.service';

@Controller('pos/notifications')
@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, RolesGuard)
export class PosNotificationsCenterController {
  constructor(private readonly service: PosNotificationsCenterService) {}

  @Get('center')
  @Roles(UserRole.SUPERADMIN, UserRole.ENCARGADO, UserRole.CAJERO, UserRole.VENDEDOR)
  getCenter(@CurrentUser() user: JwtPayload, @Query('businessId') qBid?: string) {
    const businessId = resolveBusinessId(user, qBid);
    if (!businessId) {
      throw new ForbiddenException('Sin negocio asociado');
    }
    return this.service.getNotificationCenter(businessId, user);
  }
}
