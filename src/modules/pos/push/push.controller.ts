import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import {
  MobileDeviceContext,
  MobileDeviceGuard,
} from './guards/mobile-device.guard';
import { PushService } from './push.service';
import { RegisterPushTokenDto } from './dto/register-push-token.dto';
import { UpdatePushPreferencesDto } from './dto/update-push-preferences.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard, MobileDeviceGuard)
@Controller('pos/push')
export class PushController {
  constructor(private readonly pushService: PushService) {}

  @Put('token')
  @HttpCode(HttpStatus.OK)
  registerToken(
    @Body() dto: RegisterPushTokenDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: any,
  ) {
    const mobileDevice: MobileDeviceContext = req.mobileDevice;
    return this.pushService.registerToken(
      mobileDevice.businessId,
      user.sub,
      mobileDevice.deviceId,
      dto,
      mobileDevice.platform,
    );
  }

  @Delete('token')
  @HttpCode(HttpStatus.OK)
  deactivateToken(@Req() req: any) {
    const mobileDevice: MobileDeviceContext = req.mobileDevice;
    return this.pushService.deactivateToken(mobileDevice.deviceId);
  }

  @Get('preferences')
  getPreferences(@CurrentUser() user: JwtPayload) {
    return this.pushService.getPreferences(user.sub, user.role);
  }

  @Put('preferences')
  @HttpCode(HttpStatus.OK)
  updatePreferences(
    @Body() dto: UpdatePushPreferencesDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.pushService.updatePreferences(user.sub, user.role, dto);
  }

  @Post('test')
  @HttpCode(HttpStatus.OK)
  sendTest(@CurrentUser() user: JwtPayload, @Req() req: any) {
    const mobileDevice: MobileDeviceContext = req.mobileDevice;
    return this.pushService.sendTestPush(
      mobileDevice.businessId,
      user.sub,
      mobileDevice.deviceId,
    );
  }

  @Get('inbox')
  getInbox(
    @CurrentUser() user: JwtPayload,
    @Req() req: any,
    @Query('cursor') cursor?: string,
    @Query('take') take?: string,
  ) {
    const mobileDevice: MobileDeviceContext = req.mobileDevice;
    const parsedTake = take !== undefined && take !== '' ? Number(take) : undefined;
    return this.pushService.listInbox(
      mobileDevice.businessId,
      user.sub,
      cursor,
      parsedTake,
    );
  }

  @Get('inbox/unread-count')
  getInboxUnreadCount(@CurrentUser() user: JwtPayload, @Req() req: any) {
    const mobileDevice: MobileDeviceContext = req.mobileDevice;
    return this.pushService.getInboxUnreadCount(mobileDevice.businessId, user.sub);
  }

  @Patch('inbox/:id/read')
  @HttpCode(HttpStatus.OK)
  markInboxItemRead(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Req() req: any,
  ) {
    const mobileDevice: MobileDeviceContext = req.mobileDevice;
    return this.pushService.markInboxItemRead(
      mobileDevice.businessId,
      user.sub,
      id,
    );
  }

  @Post('inbox/read-all')
  @HttpCode(HttpStatus.OK)
  markAllInboxRead(@CurrentUser() user: JwtPayload, @Req() req: any) {
    const mobileDevice: MobileDeviceContext = req.mobileDevice;
    return this.pushService.markAllInboxRead(mobileDevice.businessId, user.sub);
  }
}
