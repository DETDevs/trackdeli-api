import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards, BadRequestException, ForbiddenException, UseInterceptors } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { IdempotencyInterceptor } from "../idempotency/idempotency.interceptor";
import { PosGuard } from "../../../common/guards/pos.guard";
import { WebBillingGuard } from "../../../common/guards/web-billing.guard";
import { NoWebPlatformGuard } from "../../../common/guards/no-web-platform.guard";
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
import { CreateTipPayoutDto } from "./dto/create-tip-payout.dto";
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
    return this.service.findAll(resolveBusinessId(user, qBid), user.role, user.sub);
  }

  @Get("history")
  getHistory(@CurrentUser() user: JwtPayload, @Query("businessId") qBid?: string) {
    return this.service.findAll(resolveBusinessId(user, qBid), user.role, user.sub);
  }

  @Get("open-list")
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  getOpenList(
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.getOpenList(resolveBusinessId(user, qBid));
  }

  @Get("current")
  getCurrent(
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
    @Headers("x-device-id") deviceId?: string,
    @Headers("x-client-platform") hPlatform?: string,
  ) {
    return this.service.getCurrent(resolveBusinessId(user, qBid), user.sub, user.role, deviceId, hPlatform);
  }

  @Get("status")
  async getStatus(
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
    @Headers("x-device-id") deviceId?: string,
    @Headers("x-client-platform") hPlatform?: string,
  ) {
    const current = await this.service.getCurrent(resolveBusinessId(user, qBid), user.sub, user.role, deviceId, hPlatform);
    return {
      isOpen: !!current,
      shiftId: current?.id ?? null,
      openedAt: current?.openedAt ?? null,
      cashierName: current?.cashier?.name ?? current?.openedBy?.name ?? null,
      shift: current,
    };
  }

  @Post("open")
  @UseGuards(WebBillingGuard)
  open(
    @Body() dto: OpenCashRegisterDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
    @Headers("x-device-id") hDeviceId?: string,
    @Headers("x-device-name") hDeviceName?: string,
    @Headers("x-client-platform") hPlatform?: string,
  ) {
    const deviceId = (hDeviceId || dto.deviceId || '').trim() || undefined;
    const deviceName = (hDeviceName || dto.deviceName || '').trim() || undefined;
    return this.service.open(dto, resolveBusinessId(user, qBid), user.sub, deviceId, deviceName, user.role, hPlatform);
  }

  @Post("close")
  @UseGuards(WebBillingGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @RequirePosAction(PosAction.CIERRE_TURNO_PROPIO)
  closeCurrent(
    @Body() dto: CloseCashRegisterDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
    @Headers("x-device-id") hDeviceId?: string,
    @Headers("x-client-platform") hPlatform?: string,
  ) {
    const deviceId = (hDeviceId || dto.deviceId || '').trim() || undefined;
    return this.service.close(null, dto, resolveBusinessId(user, qBid), user.sub, user.role, deviceId, hPlatform);
  }

  @Post(":id/close")
  @UseInterceptors(IdempotencyInterceptor)
  @RequirePosAction(PosAction.CIERRE_TURNO_OTRO)
  close(
    @Param("id") id: string,
    @Body() dto: CloseCashRegisterDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
    @Headers("x-device-id") hDeviceId?: string,
    @Headers("x-client-platform") hPlatform?: string,
  ) {
    if (user.role !== UserRole.ENCARGADO && user.role !== UserRole.SUPERADMIN) {
      throw new ForbiddenException('Solo el encargado puede cerrar el turno de otra caja');
    }
    const deviceId = (hDeviceId || dto.deviceId || '').trim() || undefined;
    return this.service.close(id, dto, resolveBusinessId(user, qBid), user.sub, user.role, deviceId, hPlatform);
  }

  @Post(":id/force-close")
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  @RequirePosAction(PosAction.CIERRE_TURNO_OTRO)
  forceClose(
    @Param("id") id: string,
    @Body() dto: CloseCashRegisterDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
    @Headers("x-device-id") hDeviceId?: string,
    @Headers("x-client-platform") hPlatform?: string,
  ) {
    if (user.role === UserRole.CAJERO || (user.role !== UserRole.ENCARGADO && user.role !== UserRole.SUPERADMIN)) {
      throw new ForbiddenException('Solo el encargado puede forzar el cierre de turno de otro usuario');
    }
    if (!dto.reason) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'REASON_REQUIRED',
        message: 'El motivo es obligatorio para forzar el cierre del turno'
      });
    }
    const deviceId = (hDeviceId || dto.deviceId || '').trim() || undefined;
    return this.service.close(id, dto, resolveBusinessId(user, qBid), user.sub, user.role, deviceId, hPlatform);
  }

  @Post("movements")
  @UseGuards(WebBillingGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @RequirePosAction(PosAction.MOVIMIENTO_CAJA)
  addMovementCurrent(
    @Body() dto: CashMovementDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
    @Headers("x-device-id") hDeviceId?: string,
    @Headers("x-client-platform") hPlatform?: string,
  ) {
    return this.service.addMovement(null, dto, resolveBusinessId(user, qBid), user.sub, user.role, hDeviceId, hPlatform);
  }

  @Post(":id/movements")
  @UseGuards(WebBillingGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @RequirePosAction(PosAction.MOVIMIENTO_CAJA)
  addMovementPlural(
    @Param("id") id: string,
    @Body() dto: CashMovementDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
    @Headers("x-device-id") hDeviceId?: string,
    @Headers("x-client-platform") hPlatform?: string,
  ) {
    return this.service.addMovement(id, dto, resolveBusinessId(user, qBid), user.sub, user.role, hDeviceId, hPlatform);
  }

  @Post("tip-payouts")
  @UseGuards(WebBillingGuard)
  createTipPayout(
    @Body() dto: CreateTipPayoutDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
    @Headers("x-device-id") hDeviceId?: string,
    @Headers("x-client-platform") hPlatform?: string,
  ) {
    return this.service.createTipPayout(
      dto,
      resolveBusinessId(user, qBid),
      user.sub,
      user.role,
      hDeviceId,
      hPlatform,
    );
  }

  @Get(":id/summary")
  getSummary(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
    @Headers("x-device-id") deviceId?: string,
  ) {
    return this.service.getSummary(id, resolveBusinessId(user, qBid), user.role, user.sub, deviceId);
  }

  @Post(":id/drawer-open")
  @UseGuards(NoWebPlatformGuard)
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
  @UseGuards(NoWebPlatformGuard)
  @RequirePosAction(PosAction.ABRIR_CAJON_SIN_VENTA)
  drawerOpenCurrent(
    @Body() dto: { reason: string },
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
    @Headers("x-device-id") hDeviceId?: string,
  ) {
    return this.service.drawerOpen(null, dto.reason, resolveBusinessId(user, qBid), user.sub, user.role, hDeviceId);
  }
}
