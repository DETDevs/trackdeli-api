import {
  Body,
  Controller,
  Get,
  Patch,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { resolveBusinessId } from '../pos.utils';
import { ChannelsService } from './channels.service';
import { UpdateChannelConfigDto } from './dto/update-channel-config.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard, RolesGuard)
@Controller('pos/channels')
export class ChannelsController {
  constructor(private readonly channelsService: ChannelsService) {}

  @Get('config')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async getConfig(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.channelsService.getConfig(businessId);
  }

  @Patch('config')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async updateConfig(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateChannelConfigDto,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.channelsService.updateConfig(businessId, dto, user.role, user.sub);
  }

  @Put('config')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async updateConfigPut(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateChannelConfigDto,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.channelsService.updateConfig(businessId, dto, user.role, user.sub);
  }

  @Get('drivers')
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN, UserRole.VENDEDOR)
  async listDrivers(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.channelsService.listDrivers(businessId);
  }
}
