import {
  Body, Controller, Get, Param, Post, Query, UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { PosGuard } from "../../../common/guards/pos.guard";
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { JwtPayload } from "../../../common/types/jwt-payload.interface";
import { resolveBusinessId } from "../pos.utils";
import { SalesService } from "./sales.service";
import { CreateSaleDto } from "./dto/create-sale.dto";
import { CancelSaleDto } from "./dto/cancel-sale.dto";

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller("pos/sales")
export class SalesController {
  constructor(private readonly service: SalesService) {}

  @Get()
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("status") status?: string,
    @Query("paymentMethod") paymentMethod?: string,
    @Query("cashRegisterId") cashRegisterId?: string,
  ) {
    return this.service.findAll(resolveBusinessId(user, qBid), { from, to, status, paymentMethod, cashRegisterId });
  }

  @Post()
  create(
    @Body() dto: CreateSaleDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.create(dto, resolveBusinessId(user, qBid), user.sub);
  }

  @Get(":id")
  findOne(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.findOne(id, resolveBusinessId(user, qBid));
  }

  @Post(":id/cancel")
  cancel(
    @Param("id") id: string,
    @Body() dto: CancelSaleDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.cancel(id, resolveBusinessId(user, qBid), dto);
  }

  @Get(":id/receipt")
  receipt(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.getReceiptData(id, resolveBusinessId(user, qBid));
  }
}
