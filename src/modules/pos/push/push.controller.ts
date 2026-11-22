import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
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
}
