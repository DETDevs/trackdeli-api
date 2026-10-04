import { Body, Controller, Get, Param, Post, Query, UseGuards, BadRequestException, UseInterceptors } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { IdempotencyInterceptor } from "../idempotency/idempotency.interceptor";
import { PosGuard } from "../../../common/guards/pos.guard";
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { resolveBusinessId } from "../pos.utils";
import { CashRegisterService } from "./cash-register.service";
import { OpenCashRegisterDto } from "./dto/open-register.dto";
import { CloseCashRegisterDto } from "./dto/close-register.dto";
import { CashMovementDto } from "./dto/cash-movement.dto";
import { PosPermissionsGuard } from "../permissions/permissions.guard";
import { RequirePosAction } from "../permissions/require-action.decorator";
import { PosAction } from "../permissions/permissions.service";

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard, PosPermissionsGuard)
@Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
@Controller("pos/cash-register")
export class CashRegisterController {
  constructor(private readonly service: CashRegisterService) {}

  @Get()
  findAll(@CurrentUser() user: JwtPayload, @Query("businessId") qBid?: string) {
    return this.service.findAll(resolveBusinessId(user, qBid));
  }

  @Get("history")
  getHistory(@CurrentUser() user: JwtPayload, @Query("businessId") qBid?: string) {
    return this.service.findAll(resolveBusinessId(user, qBid), user.role);
  }

  @Get("current")
  getCurrent(@CurrentUser() user: JwtPayload, @Query("businessId") qBid?: string) {
    return this.service.getCurrent(resolveBusinessId(user, qBid), user.sub, user.role);
  }

  @Get("status")
  async getStatus(@CurrentUser() user: JwtPayload, @Query("businessId") qBid?: string) {
    const current = await this.service.getCurrent(resolveBusinessId(user, qBid), user.sub, user.role);
    return {
      isOpen: !!current,
      shiftId: current?.id ?? null,
      openedAt: current?.openedAt ?? null,
      cashierName: current?.cashier?.name ?? current?.openedBy?.name ?? null,
      shift: current,
    };
  }

  @Post("open")
  open(
    @Body() dto: OpenCashRegisterDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.open(dto, resolveBusinessId(user, qBid), user.sub);
  }

  @Post("close")
  @UseInterceptors(IdempotencyInterceptor)
  @RequirePosAction(PosAction.CIERRE_TURNO_PROPIO)
  closeCurrent(
    @Body() dto: CloseCashRegisterDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.close(null, dto, resolveBusinessId(user, qBid), user.sub, user.role);
  }

  @Post(":id/close")
  @UseInterceptors(IdempotencyInterceptor)
  @RequirePosAction(PosAction.CIERRE_TURNO_OTRO)
  close(
    @Param("id") id: string,
    @Body() dto: CloseCashRegisterDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.close(id, dto, resolveBusinessId(user, qBid), user.sub, user.role);
  }

  @Post(":id/force-close")
  @UseInterceptors(IdempotencyInterceptor)
  @RequirePosAction(PosAction.CIERRE_TURNO_OTRO)
  forceClose(
    @Param("id") id: string,
    @Body() dto: CloseCashRegisterDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    if (!dto.reason) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'REASON_REQUIRED',
        message: 'El motivo es obligatorio para forzar el cierre del turno'
      });
    }
    return this.service.close(id, dto, resolveBusinessId(user, qBid), user.sub, user.role);
  }

  @Post("movements")
  @UseInterceptors(IdempotencyInterceptor)
  @RequirePosAction(PosAction.MOVIMIENTO_CAJA)
  addMovementCurrent(
    @Body() dto: CashMovementDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.addMovement(null, dto, resolveBusinessId(user, qBid), user.sub, user.role);
  }



  @Post(":id/movements")
  @UseInterceptors(IdempotencyInterceptor)
  @RequirePosAction(PosAction.MOVIMIENTO_CAJA)
  addMovementPlural(
    @Param("id") id: string,
    @Body() dto: CashMovementDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.addMovement(id, dto, resolveBusinessId(user, qBid), user.sub, user.role);
  }

  @Get(":id/summary")
  getSummary(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.getSummary(id, resolveBusinessId(user, qBid), user.role);
  }

  @Post(":id/drawer-open")
  @RequirePosAction(PosAction.ABRIR_CAJON_SIN_VENTA)
  drawerOpen(
    @Param("id") id: string,
    @Body() dto: { reason: string },
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.drawerOpen(id, dto.reason, resolveBusinessId(user, qBid), user.sub, user.role);
  }

  @Post("drawer-open")
  @RequirePosAction(PosAction.ABRIR_CAJON_SIN_VENTA)
  drawerOpenCurrent(
    @Body() dto: { reason: string },
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.drawerOpen(null, dto.reason, resolveBusinessId(user, qBid), user.sub, user.role);
  }
}
