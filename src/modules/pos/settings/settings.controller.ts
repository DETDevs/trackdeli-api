import { Body, Controller, Get, Patch, Put, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { PosGuard } from "../../../common/guards/pos.guard";
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { JwtPayload } from "../../../common/types/jwt-payload.interface";
import { Roles } from "../../../common/decorators/roles.decorator";
import { UserRole } from "@prisma/client";
import { resolveBusinessId } from "../pos.utils";
import { SettingsService } from "./settings.service";
import { UpdatePosSettingsDto } from "./dto/update-pos-settings.dto";

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller("pos/settings")
export class SettingsController {
  constructor(private readonly service: SettingsService) {}

  @Get()
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN, UserRole.VENDEDOR)
  getSettings(@CurrentUser() user: JwtPayload, @Query("businessId") qBid?: string) {
    return this.service.getSettings(resolveBusinessId(user, qBid));
  }

  @Patch()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  updateSettings(
    @Body() dto: UpdatePosSettingsDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.updateSettings(resolveBusinessId(user, qBid), dto, user.role, user.sub);
  }

  @Put()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  updateSettingsPut(
    @Body() dto: UpdatePosSettingsDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.updateSettings(resolveBusinessId(user, qBid), dto, user.role, user.sub);
  }

  @Get("kitchen")
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  getKitchenSettings(@CurrentUser() user: JwtPayload, @Query("businessId") qBid?: string) {
    return this.service.getKitchenSettings(resolveBusinessId(user, qBid));
  }

  @Patch("kitchen")
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  updateKitchenSettings(
    @Body() dto: { mode: string },
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.updateKitchenSettings(resolveBusinessId(user, qBid), dto?.mode);
  }

  @Get("wholesale")
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  getWholesaleSettings(@CurrentUser() user: JwtPayload, @Query("businessId") qBid?: string) {
    return this.service.getWholesaleSettings(resolveBusinessId(user, qBid));
  }

  @Patch("wholesale")
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  updateWholesaleSettings(
    @Body() dto: { wholesale_enabled?: boolean; wholesaleEnabled?: boolean; enabled?: boolean },
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.updateWholesaleSettings(resolveBusinessId(user, qBid), dto, user.role, user.sub);
  }
}

