import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { PosGuard } from "../../../common/guards/pos.guard";
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { JwtPayload } from "../../../common/types/jwt-payload.interface";
import { resolveBusinessId } from "../pos.utils";
import { CashRegisterService } from "./cash-register.service";
import { OpenCashRegisterDto } from "./dto/open-register.dto";
import { CloseCashRegisterDto } from "./dto/close-register.dto";
import { CashMovementDto } from "./dto/cash-movement.dto";

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller("pos/cash-register")
export class CashRegisterController {
  constructor(private readonly service: CashRegisterService) {}

  @Get()
  findAll(@CurrentUser() user: JwtPayload, @Query("businessId") qBid?: string) {
    return this.service.findAll(resolveBusinessId(user, qBid));
  }

  @Get("current")
  getCurrent(@CurrentUser() user: JwtPayload, @Query("businessId") qBid?: string) {
    return this.service.getCurrent(resolveBusinessId(user, qBid), user.sub);
  }

  @Post("open")
  open(
    @Body() dto: OpenCashRegisterDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.open(dto, resolveBusinessId(user, qBid), user.sub);
  }

  @Post(":id/close")
  close(
    @Param("id") id: string,
    @Body() dto: CloseCashRegisterDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.close(id, dto, resolveBusinessId(user, qBid));
  }

  @Post(":id/movement")
  addMovement(
    @Param("id") id: string,
    @Body() dto: CashMovementDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.addMovement(id, dto, resolveBusinessId(user, qBid), user.sub);
  }

  @Get(":id/summary")
  getSummary(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.getSummary(id, resolveBusinessId(user, qBid));
  }
}
