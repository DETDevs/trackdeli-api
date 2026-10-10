import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { resolveBusinessId } from '../pos.utils';
import { PosDevicesService } from './pos-devices.service';
import { RegisterWebDeviceDto } from './dto/register-web-device.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller('pos')
export class WebDevicesController {
  constructor(private readonly service: PosDevicesService) {}

  @Post('web-devices/register')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Roles(UserRole.CAJERO, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  register(
    @Body() dto: RegisterWebDeviceDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: any,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.registerWebDevice(
      dto,
      businessId,
      { id: user.sub, email: user.email, role: user.role },
      req,
    );
  }

  @Get('web-devices')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.getWebDevices(businessId);
  }

  @Patch('web-devices/:id/revoke')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  revoke(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Req() req: any,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    const ipAddress = req.ip || req.connection?.remoteAddress || undefined;
    return this.service.revokeWebDevice(businessId, id, user, ipAddress);
  }

  @Get('web-billing/status')
  @Roles(UserRole.CAJERO, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  getStatus(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.getWebBillingStatus(businessId, user.sub);
  }
}
