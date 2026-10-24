import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
import { ExpensesService } from './expenses.service';
import { GetExpensesDto } from './dto/get-expenses.dto';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { VoidExpenseDto } from './dto/void-expense.dto';
import { CreateExpenseCategoryDto } from './dto/create-expense-category.dto';
import { UpdateExpenseCategoryDto } from './dto/update-expense-category.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard, CarteraCobroGuard, RolesGuard, PosPermissionsGuard)
@Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
@Controller('pos')
export class ExpensesController {
  constructor(private readonly service: ExpensesService) {}

  // --------------------------------------------------------------------------
  // Categorías de Gastos
  // --------------------------------------------------------------------------
  @Get('expense-categories')
  getCategories(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.getCategories(resolveBusinessId(user, qBid));
  }

  @Post('expense-categories')
  @RequirePosAction(PosAction.GESTION_GASTOS)
  createCategory(
    @Body() dto: CreateExpenseCategoryDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.createCategory(resolveBusinessId(user, qBid), dto);
  }

  @Patch('expense-categories/:id')
  @RequirePosAction(PosAction.GESTION_GASTOS)
  updateCategory(
    @Param('id') id: string,
    @Body() dto: UpdateExpenseCategoryDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.updateCategory(id, resolveBusinessId(user, qBid), dto);
  }

  // --------------------------------------------------------------------------
  // Gastos Operativos
  // --------------------------------------------------------------------------
  @Get('expenses')
  findAll(
    @Query() query: GetExpensesDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.findAll(resolveBusinessId(user, qBid || query.businessId), query);
  }

  @Post('expenses')
  @RequirePosAction(PosAction.GESTION_GASTOS)
  create(
    @Body() dto: CreateExpenseDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.create(resolveBusinessId(user, qBid), user.sub, dto);
  }

  @Post('expenses/:id/void')
  @RequirePosAction(PosAction.GESTION_GASTOS)
  voidExpense(
    @Param('id') id: string,
    @Body() dto: VoidExpenseDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.voidExpense(id, resolveBusinessId(user, qBid), user.sub, dto);
  }
}
