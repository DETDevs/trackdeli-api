import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { CarteraCobroGuard } from '../../../common/guards/cartera-cobro.guard';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { resolveBusinessId } from '../pos.utils';
import { PosPermissionsGuard } from '../permissions/permissions.guard';
import { RequirePosAction } from '../permissions/require-action.decorator';
import { PosAction } from '../permissions/permissions.service';
import { PayablesService } from './payables.service';
import { GetPayablesDto } from './dto/get-payables.dto';
import { CreatePayablePaymentDto } from './dto/create-payable-payment.dto';
import { VoidPayablePaymentDto } from './dto/void-payable-payment.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard, CarteraCobroGuard, RolesGuard, PosPermissionsGuard)
@Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
@Controller('pos/payables')
export class PayablesController {
  constructor(private readonly service: PayablesService) {}

  @Get('summary')
  getSummary(@CurrentUser() user: JwtPayload, @Query('businessId') qBid?: string) {
    return this.service.getSummary(resolveBusinessId(user, qBid));
  }

  @Get(':id')
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.findOne(id, resolveBusinessId(user, qBid));
  }

  @Get()
  findAll(
    @Query() query: GetPayablesDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.findAll(resolveBusinessId(user, qBid || query.businessId), query);
  }

  @Post(':id/payments')
  @RequirePosAction(PosAction.PAGAR_PROVEEDOR)
  registerPayment(
    @Param('id') id: string,
    @Body() dto: CreatePayablePaymentDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.registerPayment(
      id,
      dto,
      resolveBusinessId(user, qBid),
      user.sub,
    );
  }

  @Post(':id/payments/:paymentId/void')
  @RequirePosAction(PosAction.PAGAR_PROVEEDOR)
  voidPayment(
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
    @Body() dto: VoidPayablePaymentDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.voidPayment(
      id,
      paymentId,
      dto,
      resolveBusinessId(user, qBid),
      user.sub,
    );
  }
}
