import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { resolveBusinessId } from '../pos.utils';
import { PosDevicesService } from './pos-devices.service';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller('pos/devices')
export class PosDevicesController {
  constructor(private readonly service: PosDevicesService) {}

  @Get()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN, UserRole.CAJERO)
  getDevices(@CurrentUser() user: JwtPayload) {
    const businessId = resolveBusinessId(user);
    return this.service.getBusinessDevices(businessId);
  }
}
