import {
  Body, Controller, Get, Param, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { PosGuard } from "../../../common/guards/pos.guard";
import { WebBillingGuard } from "../../../common/guards/web-billing.guard";
import { NoWebPlatformGuard } from "../../../common/guards/no-web-platform.guard";
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { JwtPayload } from "../../../common/types/jwt-payload.interface";
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { resolveBusinessId } from "../pos.utils";
import { SalesService } from "./sales.service";
import { CreateSaleDto } from "./dto/create-sale.dto";
import { CancelSaleDto } from "./dto/cancel-sale.dto";
import { PosPermissionsGuard } from "../permissions/permissions.guard";
import { RequirePosAction } from "../permissions/require-action.decorator";
import { PosAction } from "../permissions/permissions.service";

import { IdempotencyInterceptor } from "../idempotency/idempotency.interceptor";
import { UseInterceptors } from "@nestjs/common";

import { VoidSaleDto } from "./dto/void-sale.dto";
import { CreateReturnDto } from "./dto/create-return.dto";

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard, PosPermissionsGuard)
@Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
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
    return this.service.findAll(resolveBusinessId(user, qBid), { from, to, status, paymentMethod, cashRegisterId }, user.role);
  }

  @Post()
  @UseGuards(WebBillingGuard)
  @RequirePosAction(PosAction.VENDER_COBRAR)
  @UseInterceptors(IdempotencyInterceptor)
  create(
    @Body() dto: CreateSaleDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: any,
    @Query("businessId") qBid?: string,
  ) {
    const platform = (req.headers['x-client-platform'] || req.headers['X-Client-Platform'] || '').toString().toLowerCase();
    const channel = platform.startsWith('web') ? 'WEB' : 'DESKTOP';
    const deviceId = (req.headers['x-device-id'] || req.headers['X-Device-Id'] || null)?.toString().trim() || null;
    return this.service.create(dto, resolveBusinessId(user, qBid), user.sub, user.role, { channel, deviceId });
  }

  @Get(":id")
  findOne(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.findOne(id, resolveBusinessId(user, qBid), user.role);
  }

  @Post(":id/void")
  @RequirePosAction(PosAction.ANULAR_VENTA_COBRADA)
  @UseGuards(NoWebPlatformGuard)
  @UseInterceptors(IdempotencyInterceptor)
  void(
    @Param("id") id: string,
    @Body() dto: VoidSaleDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: any,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.voidSale(id, resolveBusinessId(user, qBid), user.sub, user.role, dto);
  }

  @Post(":id/cancel")
  @RequirePosAction(PosAction.ANULAR_VENTA_COBRADA)
  @UseGuards(NoWebPlatformGuard)
  @UseInterceptors(IdempotencyInterceptor)
  cancel(
    @Param("id") id: string,
    @Body() dto: CancelSaleDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: any,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.voidSale(id, resolveBusinessId(user, qBid), user.sub, user.role, {
      reason: dto.reason || 'Cancelación de venta',
      approvalToken: dto.approvalToken,
    });
  }

  @Post(":id/returns")
  @RequirePosAction(PosAction.DEVOLUCION)
  @UseGuards(NoWebPlatformGuard)
  @UseInterceptors(IdempotencyInterceptor)
  createReturn(
    @Param("id") id: string,
    @Body() dto: CreateReturnDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: any,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.createReturn(id, resolveBusinessId(user, qBid), user.sub, user.role, dto);
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
