import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  Headers,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { PosGuard } from "../../../common/guards/pos.guard";
import { SkipMembershipCheck } from "../../../common/decorators/skip-membership.decorator";
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { JwtPayload } from "../../../common/types/jwt-payload.interface";
import { Roles } from "../../../common/decorators/roles.decorator";
import { UserRole } from "@prisma/client";
import { resolveBusinessId } from "../pos.utils";
import { OfflineService } from "./offline.service";
import {
  RegisterTerminalDto,
  UpdateTerminalStatusDto,
  SyncOfflineBatchDto,
  ResolveDiscrepancyDto,
} from "./dto/offline.dto";

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller("pos")
export class OfflineController {
  constructor(private readonly service: OfflineService) {}

  @Get("offline-eligibility")
  checkEligibility(
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
    @Query("deviceIdentifier") deviceIdentifier?: string,
    @Query("pendingCount") pendingCount?: string,
    @Headers("x-device-identifier") hDeviceIdentifier?: string,
  ) {
    const finalDevice = deviceIdentifier || hDeviceIdentifier;
    const count = pendingCount !== undefined ? parseInt(pendingCount, 10) : undefined;
    return this.service.checkEligibility(resolveBusinessId(user, qBid), finalDevice, count);
  }

  @Post("sync-offline-sales")
  syncOfflineSales(
    @Body() dto: SyncOfflineBatchDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.syncOfflineSales(resolveBusinessId(user, qBid), user.sub, dto);
  }

  @Get("catalog-snapshot")
  getCatalogSnapshot(
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
    @Query("since") since?: string,
  ) {
    return this.service.getCatalogSnapshot(resolveBusinessId(user, qBid), since);
  }

  @Post("terminals")
  registerTerminal(
    @Body() dto: RegisterTerminalDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.registerTerminal(resolveBusinessId(user, qBid), dto);
  }

  @Get("terminals")
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  getTerminals(
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.getTerminals(resolveBusinessId(user, qBid));
  }

  @Patch("terminals/:id")
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  updateTerminal(
    @Param("id") id: string,
    @Body() dto: UpdateTerminalStatusDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.updateTerminal(id, resolveBusinessId(user, qBid), dto);
  }

  @Get("inventory-discrepancies")
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  getDiscrepancies(
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
    @Query("resolved") resolved?: string,
  ) {
    const isResolved = resolved !== undefined ? resolved === "true" : undefined;
    return this.service.getDiscrepancies(resolveBusinessId(user, qBid), isResolved);
  }

  @Patch("inventory-discrepancies/:id/resolve")
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  resolveDiscrepancy(
    @Param("id") id: string,
    @Body() dto: ResolveDiscrepancyDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.resolveDiscrepancy(id, resolveBusinessId(user, qBid), user.sub, dto);
  }
}

