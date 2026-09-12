import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
import { TablesService } from './tables.service';
import { CreateTableDto } from './dto/create-table.dto';
import { UpdateTableDto } from './dto/update-table.dto';
import { AddOrderItemsDto } from './dto/add-order-items.dto';
import { UpdateOrderItemDto } from './dto/update-order-item.dto';
import { CheckoutTableOrderDto } from './dto/checkout-table-order.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller('pos/tables')
export class TablesController {
  constructor(private readonly service: TablesService) {}

  // ==========================================
  // 1. GESTIÓN DE MESAS Y STATUS
  // ==========================================

  @Get()
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.findAllTables(resolveBusinessId(user, qBid));
  }

  @Post()
  createTable(
    @Body() dto: CreateTableDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.createTable(resolveBusinessId(user, qBid), dto);
  }

  @Get('status')
  getTablesStatus(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.getTablesStatus(resolveBusinessId(user, qBid));
  }

  @Patch(':id')
  updateTable(
    @Param('id') id: string,
    @Body() dto: UpdateTableDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.updateTable(resolveBusinessId(user, qBid), id, dto);
  }

  @Delete(':id')
  deleteTable(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.deleteTable(resolveBusinessId(user, qBid), id);
  }

  // ==========================================
  // 2. FLUJO DE PEDIDOS POR MESA
  // ==========================================

  @Post(':id/open-order')
  @HttpCode(HttpStatus.OK)
  openOrder(
    @Param('id') tableId: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.openTableOrder(resolveBusinessId(user, qBid), tableId);
  }

  @Get(':id/order')
  getActiveOrder(
    @Param('id') tableId: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.getActiveTableOrder(resolveBusinessId(user, qBid), tableId);
  }

  @Post(':id/order/items')
  addItems(
    @Param('id') tableId: string,
    @Body() dto: AddOrderItemsDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.addOrderItems(resolveBusinessId(user, qBid), tableId, dto);
  }

  @Patch(':id/order/items/:itemId')
  updateItem(
    @Param('id') tableId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateOrderItemDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.updateOrderItem(
      resolveBusinessId(user, qBid),
      tableId,
      itemId,
      dto,
    );
  }

  @Delete(':id/order/items/:itemId')
  deleteItem(
    @Param('id') tableId: string,
    @Param('itemId') itemId: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.deleteOrderItem(
      resolveBusinessId(user, qBid),
      tableId,
      itemId,
    );
  }

  @Post(':id/order/checkout')
  @HttpCode(HttpStatus.OK)
  checkout(
    @Param('id') tableId: string,
    @Body() dto: CheckoutTableOrderDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.checkoutTableOrder(
      resolveBusinessId(user, qBid),
      user.sub,
      tableId,
      dto,
    );
  }
}
