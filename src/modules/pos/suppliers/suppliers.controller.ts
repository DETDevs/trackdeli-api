import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { resolveBusinessId } from '../pos.utils';
import { SuppliersService } from './suppliers.service';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller('pos/suppliers')
export class SuppliersController {
  constructor(private readonly service: SuppliersService) {}

  @Get()
  findAll(@CurrentUser() user: JwtPayload, @Query('businessId') qBid?: string) {
    return this.service.findAll(resolveBusinessId(user, qBid));
  }

  @Post()
  create(@Body() dto: CreateSupplierDto, @CurrentUser() user: JwtPayload, @Query('businessId') qBid?: string) {
    return this.service.create(dto, resolveBusinessId(user, qBid));
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSupplierDto, @CurrentUser() user: JwtPayload, @Query('businessId') qBid?: string) {
    return this.service.update(id, dto, resolveBusinessId(user, qBid));
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: JwtPayload, @Query('businessId') qBid?: string) {
    return this.service.remove(id, resolveBusinessId(user, qBid));
  }
}
