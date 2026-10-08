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
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { resolveBusinessId } from '../pos.utils';
import { TablesService } from './tables.service';
import { CreateTableDto } from './dto/create-table.dto';
import { UpdateTableDto } from './dto/update-table.dto';
import { AddOrderItemsDto } from './dto/add-order-items.dto';
import { UpdateOrderItemDto } from './dto/update-order-item.dto';
import { CheckoutTableOrderDto } from './dto/checkout-table-order.dto';
import { CancelTableOrderDto } from './dto/cancel-table-order.dto';
import { ReceiveVehicleDto } from './dto/receive-vehicle.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller('pos/tables')
export class TablesController {
  constructor(private readonly service: TablesService) {}

  @Get()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
    @Query('zoneId') zoneId?: string,
  ) {
    return this.service.findAllTables(resolveBusinessId(user, qBid), zoneId);
  }

  @Post()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  createTable(
    @Body() dto: CreateTableDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.createTable(resolveBusinessId(user, qBid), dto, user);
  }

  @Post('receive')
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN, UserRole.WAITER)
  receiveVehicle(
    @Body() dto: ReceiveVehicleDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.receiveVehicle(resolveBusinessId(user, qBid), dto, user);
  }

  @Get('status')
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN, UserRole.WAITER)
  getTablesStatus(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
    @Query('zoneId') zoneId?: string,
  ) {
    return this.service.getTablesStatus(resolveBusinessId(user, qBid), zoneId);
  }

  @Patch(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  updateTable(
    @Param('id') id: string,
    @Body() dto: UpdateTableDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.updateTable(resolveBusinessId(user, qBid), id, dto, user);
  }

  @Delete(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  deleteTable(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.deleteTable(resolveBusinessId(user, qBid), id, user);
  }

  @Post(':id/open-order')
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN, UserRole.WAITER)
  @HttpCode(HttpStatus.OK)
  openOrder(
    @Param('id') tableId: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.openTableOrder(resolveBusinessId(user, qBid), tableId, user);
  }

  @Get(':id/order')
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN, UserRole.WAITER)
  getActiveOrder(
    @Param('id') tableId: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.getActiveTableOrder(resolveBusinessId(user, qBid), tableId);
  }

  @Post(':id/order/items')
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN, UserRole.WAITER)
  addItems(
    @Param('id') tableId: string,
    @Body() dto: AddOrderItemsDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.addOrderItems(resolveBusinessId(user, qBid), tableId, dto, user);
  }

  @Patch(':id/order/items/:itemId')
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN, UserRole.WAITER)
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
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN, UserRole.WAITER)
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
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
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

  @Post(':id/order/cancel')
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
  @HttpCode(HttpStatus.OK)
  cancelOrder(
    @Param('id') tableId: string,
    @Body() dto: CancelTableOrderDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.cancelTableOrder(
      resolveBusinessId(user, qBid),
      user,
      tableId,
      dto,
    );
  }
}

