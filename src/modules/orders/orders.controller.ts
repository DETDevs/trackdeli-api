import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { OrderStatus, UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';

@Controller('orders')
export class OrdersController {
  constructor(private readonly service: OrdersService) {}

  @Get()
  @Roles(UserRole.ENCARGADO, UserRole.REPARTIDOR, UserRole.SUPERADMIN)
  findAll(@CurrentUser() user: JwtPayload, @Query('status') status?: OrderStatus) {
    return this.service.findAllByBusiness(user.businessId, user.sub, user.role, { status });
  }

  @Get(':id')
  @Roles(UserRole.ENCARGADO, UserRole.REPARTIDOR, UserRole.SUPERADMIN)
  findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.findOne(id, user.businessId);
  }

  @Post()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  create(@Body() dto: CreateOrderDto, @CurrentUser() user: JwtPayload) {
    return this.service.create(dto, user.sub, user.businessId);
  }

  @Post(':id/take')
  @Roles(UserRole.REPARTIDOR)
  takeOrder(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.takeOrder(id, user.sub, user.businessId);
  }

  @Patch(':id/status')
  @Roles(UserRole.ENCARGADO, UserRole.REPARTIDOR, UserRole.SUPERADMIN)
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
    @CurrentUser() user: JwtPayload
  ) {
    return this.service.updateStatus(id, dto, user.sub, user.role, user.businessId);
  }

  @Get('health')
  @Public()
  healthCheck() {
    return { status: 'ok', module: 'orders' };
  }
}
