import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { PosGuard } from "../../../common/guards/pos.guard";
import { CarteraCobroGuard } from "../../../common/guards/cartera-cobro.guard";
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { JwtPayload } from "../../../common/types/jwt-payload.interface";
import { Roles } from "../../../common/decorators/roles.decorator";
import { UserRole } from "@prisma/client";
import { resolveBusinessId } from "../pos.utils";
import { ReportsService } from "./reports.service";

@SkipMembershipCheck()
@Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
@UseGuards(JwtAuthGuard, PosGuard)
@Controller(["pos/reports", "reports"])
export class ReportsController {
  constructor(private readonly service: ReportsService) {}

  @Get()
  overview(
    @CurrentUser() user: JwtPayload,
    @Query("period") period?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.getOverview(resolveBusinessId(user, qBid), period, from, to);
  }

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

  @UseGuards(CarteraCobroGuard)
  @Get("credit-overdue")
  creditOverdue(
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.getCreditOverdue(resolveBusinessId(user, qBid));
  }

  @UseGuards(CarteraCobroGuard)
  @Get("credit-summary")
  creditSummary(
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
    @Query("q") q?: string,
    @Query("onlyOverdue") onlyOverdue?: string | boolean,
    @Query("status") status?: string,
    @Query("sortBy") sortBy?: string,
    @Query("sortOrder") sortOrder?: 'asc' | 'desc',
    @Query("page") page?: number,
    @Query("limit") limit?: number,
  ) {
    return this.service.getCreditSummary(resolveBusinessId(user, qBid), {
      q,
      onlyOverdue: onlyOverdue === 'true' || onlyOverdue === true || status === 'OVERDUE',
      status,
      sortBy: sortBy as any,
      sortOrder,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @UseGuards(CarteraCobroGuard)
  @Get("credit-sales-by-product")
  creditSalesByProduct(
    @CurrentUser() user: JwtPayload,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.getCreditSalesByProduct(
      resolveBusinessId(user, qBid),
      from,
      to,
    );
  }
}
