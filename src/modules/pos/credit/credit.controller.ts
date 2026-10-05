import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CarteraCobroGuard } from '../../../common/guards/cartera-cobro.guard';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { resolveBusinessId } from '../pos.utils';
import { CreditService } from './credit.service';
import { RegisterCreditPaymentDto } from './dto/register-payment.dto';
import { CreateCreditGroupDto } from './dto/create-credit-group.dto';
import { UpdateCreditGroupDto } from './dto/update-credit-group.dto';
import { CreateCreditStatementDto } from './dto/create-statement.dto';
import { SettleCreditStatementDto } from './dto/settle-statement.dto';
import { PosPermissionsGuard } from '../permissions/permissions.guard';
import { RequirePosAction } from '../permissions/require-action.decorator';
import { PosAction } from '../permissions/permissions.service';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor';

import { PosGuard } from '../../../common/guards/pos.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard, CarteraCobroGuard, PosPermissionsGuard)
@Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
@Controller()
export class CreditController {
  constructor(private readonly service: CreditService) {}

  // -------------------------------------------------------------
  // ABONOS INDIVIDUALES EXISTENTES
  // -------------------------------------------------------------
  @Post(['pos/credit-accounts/:id/payments', 'credit-accounts/:id/payments'])
  @RequirePosAction(PosAction.ABONAR_CREDITO)
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

  // -------------------------------------------------------------
  // EMPRESAS / CONVENIOS (CREDIT GROUPS)
  // -------------------------------------------------------------
  @Post(['pos/credit/groups', 'credit/groups'])
  @RequirePosAction(PosAction.GROUP_MANAGE)
  createGroup(
    @Body() dto: CreateCreditGroupDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.createGroup(
      resolveBusinessId(user, qBid),
      dto,
      user.sub,
      user.role,
    );
  }

  @Get(['pos/credit/groups', 'credit/groups'])
  @RequirePosAction(PosAction.GROUP_MANAGE)
  findAllGroups(
    @Query('isActive') isActive: string,
    @Query('q') q: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const activeBool = isActive !== undefined ? isActive === 'true' || isActive === '1' : undefined;
    return this.service.findAllGroups(resolveBusinessId(user, qBid), {
      isActive: activeBool,
      q,
    });
  }

  @Get(['pos/credit/groups/:id/next-cut', 'credit/groups/:id/next-cut'])
  @RequirePosAction(PosAction.GROUP_MANAGE)
  getNextCut(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.getNextCut(resolveBusinessId(user, qBid), id);
  }

  @Get(['pos/credit/groups/:id', 'credit/groups/:id'])
  @RequirePosAction(PosAction.GROUP_MANAGE)
  findGroupById(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.findGroupById(resolveBusinessId(user, qBid), id);
  }

  @Patch(['pos/credit/groups/:id', 'credit/groups/:id'])
  @RequirePosAction(PosAction.GROUP_MANAGE)
  updateGroup(
    @Param('id') id: string,
    @Body() dto: UpdateCreditGroupDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.updateGroup(
      resolveBusinessId(user, qBid),
      id,
      dto,
      user.sub,
      user.role,
    );
  }

  @Delete(['pos/credit/groups/:id', 'credit/groups/:id'])
  @RequirePosAction(PosAction.GROUP_MANAGE)
  deleteGroup(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.deleteGroup(
      resolveBusinessId(user, qBid),
      id,
      user.sub,
      user.role,
    );
  }

  // -------------------------------------------------------------
  // REPORTE DE DEDUCCIÓN POR EMPRESA
  // -------------------------------------------------------------
  @Get(['pos/credit/groups/:id/statement', 'credit/groups/:id/statement'])
  @RequirePosAction(PosAction.GROUP_STATEMENT)
  async getGroupStatementReport(
    @Param('id') id: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('format') format: string = 'json',
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 100,
    @CurrentUser() user: JwtPayload,
    @Res({ passthrough: true }) res: Response,
    @Query('businessId') qBid?: string,
  ) {
    const result = await this.service.getGroupStatementReport(
      resolveBusinessId(user, qBid),
      id,
      from,
      to,
      format,
      page,
      limit,
    );

    if (result && (result as any).isCsv) {
      const csvObj = result as any;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${csvObj.filename}"`);
      return csvObj.csvData;
    }

    return result;
  }

  // -------------------------------------------------------------
  // CORTES CONGELADOS Y LIQUIDACIÓN
  // -------------------------------------------------------------
  @Post(['pos/credit/groups/:id/statements', 'credit/groups/:id/statements'])
  @RequirePosAction(PosAction.GROUP_STATEMENT)
  createStatement(
    @Param('id') groupId: string,
    @Body() dto: CreateCreditStatementDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.createStatement(
      resolveBusinessId(user, qBid),
      groupId,
      dto,
      user.sub,
      user.role,
    );
  }

  @Get(['pos/credit/groups/:id/statements', 'credit/groups/:id/statements'])
  @RequirePosAction(PosAction.GROUP_STATEMENT)
  findStatementsByGroup(
    @Param('id') groupId: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.findStatementsByGroup(
      resolveBusinessId(user, qBid),
      groupId,
    );
  }

  @Get(['pos/credit/statements/:id', 'credit/statements/:id'])
  @RequirePosAction(PosAction.GROUP_STATEMENT)
  findStatementById(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.findStatementById(
      resolveBusinessId(user, qBid),
      id,
    );
  }

  @Post(['pos/credit/statements/:id/settle', 'credit/statements/:id/settle'])
  @RequirePosAction(PosAction.GROUP_SETTLE)
  @UseInterceptors(IdempotencyInterceptor)
  settleStatement(
    @Param('id') id: string,
    @Body() dto: SettleCreditStatementDto,
    @Headers() headers: Record<string, string>,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const idempKey = headers['idempotency-key'] || headers['Idempotency-Key'];
    if (!idempKey) {
      throw new BadRequestException('El encabezado Idempotency-Key es obligatorio para liquidar cortes');
    }

    return this.service.settleStatement(
      resolveBusinessId(user, qBid),
      id,
      dto,
      user.sub,
      user.role,
    );
  }

  @Patch(['pos/credit/statements/:id/cancel', 'credit/statements/:id/cancel'])
  @RequirePosAction(PosAction.GROUP_STATEMENT)
  cancelStatement(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.cancelStatement(
      resolveBusinessId(user, qBid),
      id,
      user.sub,
      user.role,
    );
  }
}
