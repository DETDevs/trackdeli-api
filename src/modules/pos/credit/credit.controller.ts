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
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { resolveBusinessId } from '../pos.utils';
import { CreditService } from './credit.service';
import { RegisterCreditPaymentDto } from './dto/register-payment.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller()
export class CreditController {
  constructor(private readonly service: CreditService) {}

  @Post(['pos/credit-accounts/:id/payments', 'credit-accounts/:id/payments'])
  registerPayment(
    @Param('id') id: string,
    @Body() dto: RegisterCreditPaymentDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.registerPayment(
      id,
      dto,
      user.sub,
      resolveBusinessId(user, qBid),
    );
  }

  @Get(['pos/customers/:id/credit-accounts', 'customers/:id/credit-accounts'])
  getCustomerCreditAccounts(
    @Param('id') customerId: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.getCustomerCreditAccounts(
      customerId,
      resolveBusinessId(user, qBid),
    );
  }

  @Get(['pos/credit-accounts/:id', 'credit-accounts/:id'])
  getCreditAccount(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.getCreditAccount(id, resolveBusinessId(user, qBid));
  }
}
