import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { Roles } from '../../../common/decorators/roles.decorator';
import { PosDeviceStatus, UserRole } from '@prisma/client';
import { resolveBusinessId } from '../pos.utils';
import { PosDevicesService } from './pos-devices.service';
import { UpdateDeviceDto } from './dto/update-device.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller('pos/devices')
export class PosDevicesController {
  constructor(private readonly service: PosDevicesService) {}

  @Get()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN, UserRole.CAJERO)
  getDevices(@CurrentUser() user: JwtPayload, @Query('businessId') qBid?: string) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.getBusinessDevices(businessId);
  }

  @Patch(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  updateDevice(
    @Param('id') id: string,
    @Body() dto: UpdateDeviceDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.updateDevice(businessId, id, dto, user);
  }

  @Patch(':id/revoke')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  revokeDevice(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.updateDevice(
      businessId,
      id,
      { status: PosDeviceStatus.REVOKED },
      user,
    );
  }
}
