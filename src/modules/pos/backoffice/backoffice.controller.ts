import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { BackofficeGuard } from './backoffice.guard';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { resolveBusinessId } from '../pos.utils';
import { BackofficeService } from './backoffice.service';
import {
  BackofficeSalesQueryDto,
  BackofficeDateRangeDto,
  BackofficeInventoryQueryDto,
  BackofficeCashRegisterQueryDto,
} from './dto/backoffice-query.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, BackofficeGuard)
@Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
@Controller(['backoffice', 'pos/backoffice'])
export class BackofficeController {
  constructor(private readonly backofficeService: BackofficeService) {}

  @Get('dashboard')
  getDashboard(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.backofficeService.getDashboard(businessId);
  }

  @Get('sales')
  getSales(
    @CurrentUser() user: JwtPayload,
    @Query() query: BackofficeSalesQueryDto,
  ) {
    const businessId = resolveBusinessId(user, query.businessId);
    return this.backofficeService.getSales(businessId, query);
  }

  @Get('sales/:id')
  getSaleDetail(
    @CurrentUser() user: JwtPayload,
    @Param('id') saleId: string,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.backofficeService.getSaleDetail(businessId, saleId);
  }

  @Get('top-products')
  getTopProducts(
    @CurrentUser() user: JwtPayload,
    @Query() query: BackofficeDateRangeDto,
  ) {
    const businessId = resolveBusinessId(user, query.businessId);
    return this.backofficeService.getTopProducts(businessId, query);
  }

  @Get('sales-by-category')
  getSalesByCategory(
    @CurrentUser() user: JwtPayload,
    @Query() query: BackofficeDateRangeDto,
  ) {
    const businessId = resolveBusinessId(user, query.businessId);
    return this.backofficeService.getSalesByCategory(businessId, query);
  }

  @Get('inventory')
  getInventory(
    @CurrentUser() user: JwtPayload,
    @Query() query: BackofficeInventoryQueryDto,
  ) {
    const businessId = resolveBusinessId(user, query.businessId);
    return this.backofficeService.getInventory(businessId, query);
  }

  @Get('cash-registers')
  getCashRegisters(
    @CurrentUser() user: JwtPayload,
    @Query() query: BackofficeCashRegisterQueryDto,
  ) {
    const businessId = resolveBusinessId(user, query.businessId);
    return this.backofficeService.getCashRegisters(businessId, query);
  }

  @Get('cash-registers/:id')
  getCashRegisterDetail(
    @CurrentUser() user: JwtPayload,
    @Param('id') registerId: string,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.backofficeService.getCashRegisterDetail(businessId, registerId);
  }
}
