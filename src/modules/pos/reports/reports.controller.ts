import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { PosGuard } from "../../../common/guards/pos.guard";
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { JwtPayload } from "../../../common/types/jwt-payload.interface";
import { resolveBusinessId } from "../pos.utils";
import { ReportsService } from "./reports.service";

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller("pos/reports")
export class ReportsController {
  constructor(private readonly service: ReportsService) {}

  @Get("sales-summary")
  salesSummary(
    @CurrentUser() user: JwtPayload,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.getSalesSummary(resolveBusinessId(user, qBid), from, to);
  }

  @Get("products")
  topProducts(
    @CurrentUser() user: JwtPayload,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limit?: string,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.getTopProducts(resolveBusinessId(user, qBid), from, to, limit ? +limit : 10);
  }

  @Get("daily")
  daily(@CurrentUser() user: JwtPayload, @Query("businessId") qBid?: string) {
    return this.service.getDaily(resolveBusinessId(user, qBid));
  }

  @Get("stock-alerts")
  stockAlerts(@CurrentUser() user: JwtPayload, @Query("businessId") qBid?: string) {
    return this.service.getStockAlerts(resolveBusinessId(user, qBid));
  }

  @Get("cash-registers")
  cashRegisters(
    @CurrentUser() user: JwtPayload,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.getCashRegisters(resolveBusinessId(user, qBid), from, to);
  }

  @Get("movements")
  movements(
    @CurrentUser() user: JwtPayload,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.getCashMovements(resolveBusinessId(user, qBid), from, to);
  }
}
