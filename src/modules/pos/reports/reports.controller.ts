import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { PosGuard } from "../../../common/guards/pos.guard";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { CarteraCobroGuard } from "../../../common/guards/cartera-cobro.guard";
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { JwtPayload } from "../../../common/types/jwt-payload.interface";
import { Roles } from "../../../common/decorators/roles.decorator";
import { UserRole } from "@prisma/client";
import { resolveBusinessId } from "../pos.utils";
import { ReportsService } from "./reports.service";
import { BatchesService } from "../batches/batches.service";

@SkipMembershipCheck()
@Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
@UseGuards(JwtAuthGuard, PosGuard, RolesGuard)
@Controller(["pos/reports", "reports"])
export class ReportsController {
  constructor(
    private readonly service: ReportsService,
    private readonly batchesService: BatchesService,
  ) {}

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
    @Query("period") period?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.getSalesSummary(resolveBusinessId(user, qBid), period, from, to);
  }

  @Get("products")
  topProducts(
    @CurrentUser() user: JwtPayload,
    @Query("period") period?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limit?: string,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.getTopProducts(resolveBusinessId(user, qBid), period, from, to, limit ? +limit : 10);
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

  @Get("profit")
  profit(
    @CurrentUser() user: JwtPayload,
    @Query("period") period?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.getProfit(resolveBusinessId(user, qBid), period, from, to);
  }

  @UseGuards(CarteraCobroGuard)
  @Get("income-statement")
  incomeStatement(
    @CurrentUser() user: JwtPayload,
    @Query("period") period?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.getIncomeStatement(resolveBusinessId(user, qBid), period, from, to);
  }

  @Get("sales-by-time")
  salesByTime(
    @CurrentUser() user: JwtPayload,
    @Query("period") period?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.getSalesByTime(resolveBusinessId(user, qBid), period, from, to);
  }

  @Get("sales-by-category")
  salesByCategory(
    @CurrentUser() user: JwtPayload,
    @Query("period") period?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.getSalesByCategory(resolveBusinessId(user, qBid), period, from, to);
  }

  @Get("control")
  control(
    @CurrentUser() user: JwtPayload,
    @Query("period") period?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.getControl(resolveBusinessId(user, qBid), period, from, to);
  }

  @Get("sales-by-cashier")
  salesByCashier(
    @CurrentUser() user: JwtPayload,
    @Query("period") period?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.getSalesByCashier(resolveBusinessId(user, qBid), period, from, to);
  }

  @Get("workshop")
  workshop(
    @CurrentUser() user: JwtPayload,
    @Query("period") period?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.getWorkshopReport(resolveBusinessId(user, qBid), period, from, to);
  }

  /**
   * GET /pos/reports/batch-traceability?batchId=... o ?productId=...&batchNumber=...
   * Trazabilidad completa de un lote (recibido, ventas, devoluciones, mermas, saldo).
   */
  @Get("batch-traceability")
  batchTraceability(
    @CurrentUser() user: JwtPayload,
    @Query("batchId") batchId?: string,
    @Query("productId") productId?: string,
    @Query("batchNumber") batchNumber?: string,
    @Query("businessId") qBid?: string,
  ) {
    return this.batchesService.getBatchTraceability(resolveBusinessId(user, qBid), {
      batchId,
      productId,
      batchNumber,
    });
  }

  /**
   * GET /pos/reports/sales-by-batch?from=...&to=...&productId=...
   * Ventas del periodo agrupadas por producto y lote.
   */
  @Get("sales-by-batch")
  salesByBatch(
    @CurrentUser() user: JwtPayload,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("productId") productId?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("businessId") qBid?: string,
  ) {
    return this.batchesService.getSalesByBatch(resolveBusinessId(user, qBid), {
      from,
      to,
      productId,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });
  }

  /**
   * GET /pos/reports/expired-loss?from=...&to=...
   * Mermas por vencimiento del periodo con cálculo de pérdida.
   */
  @Get("expired-loss")
  expiredLoss(
    @CurrentUser() user: JwtPayload,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("businessId") qBid?: string,
  ) {
    return this.batchesService.getExpiredLoss(resolveBusinessId(user, qBid), { from, to });
  }

  @Get("sales-by-seller")
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN, UserRole.VENDEDOR)
  salesBySeller(
    @CurrentUser() user: JwtPayload,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("sellerId") sellerId?: string,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.getSalesBySeller(resolveBusinessId(user, qBid), user, from, to, sellerId);
  }
}
