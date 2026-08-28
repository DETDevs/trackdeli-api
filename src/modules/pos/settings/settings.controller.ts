import { Body, Controller, Get, Patch, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { PosGuard } from "../../../common/guards/pos.guard";
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { JwtPayload } from "../../../common/types/jwt-payload.interface";
import { resolveBusinessId } from "../pos.utils";
import { SettingsService } from "./settings.service";
import { UpdatePosSettingsDto } from "./dto/update-pos-settings.dto";

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller("pos/settings")
export class SettingsController {
  constructor(private readonly service: SettingsService) {}

  @Get()
  getSettings(@CurrentUser() user: JwtPayload, @Query("businessId") qBid?: string) {
    return this.service.getSettings(resolveBusinessId(user, qBid));
  }

  @Patch()
  updateSettings(
    @Body() dto: UpdatePosSettingsDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.updateSettings(resolveBusinessId(user, qBid), dto);
  }
}
