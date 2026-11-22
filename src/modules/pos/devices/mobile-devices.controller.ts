import {
  Body,
  Controller,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { Public } from '../../../common/decorators/public.decorator';
import {
  SkipMembershipCheck,
  SkipMembership,
} from '../../../common/decorators/skip-membership.decorator';
import { SkipWebAdminAccess } from '../../../common/decorators/skip-web-admin-access.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { resolveBusinessId } from '../pos.utils';
import { PosDevicesService } from './pos-devices.service';
import { PairMobileDeviceDto } from './dto/pair-mobile-device.dto';

@SkipMembershipCheck()
@Controller('pos/mobile-devices')
export class MobileDevicesController {
  constructor(private readonly service: PosDevicesService) {}

  /**
   * 277a - Generar código de vinculación para app móvil (8 caracteres, vence a los 10 min).
   * Solo ENCARGADO y SUPERADMIN.
   */
  @Post('pairing-codes')
  @UseGuards(JwtAuthGuard, PosGuard)
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async createPairingCode(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.createMobilePairingCode(businessId, user.sub);
  }

  /**
   * 277a - Vincular teléfono con código (sin sesión previa).
   */
  @Post('pair')
  @Public()
  @SkipMembership()
  @SkipWebAdminAccess()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async pair(@Body() dto: PairMobileDeviceDto, @Req() req: any) {
    const ip = req?.ip || req?.connection?.remoteAddress || undefined;
    return this.service.pairMobileDevice(dto, ip);
  }
}
