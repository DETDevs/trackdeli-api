import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { resolveBusinessId } from '../pos.utils';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { ReorderCategoriesDto } from './dto/reorder-categories.dto';
import { MoveCategoryProductsDto } from './dto/move-category-products.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller('pos/categories')
export class CategoriesController {
  constructor(private readonly service: CategoriesService) {}

  @Get('summary')
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN, UserRole.WAITER)
  getSummary(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') queryBusinessId?: string,
  ) {
    return this.service.getSummary(
      resolveBusinessId(user, queryBusinessId),
      user.role,
    );
  }

  @Get()
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN, UserRole.WAITER)
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') queryBusinessId?: string,
  ) {
    return this.service.findAll(resolveBusinessId(user, queryBusinessId));
  }

  @Post()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  create(
    @Body() dto: CreateCategoryDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') queryBusinessId?: string,
  ) {
    return this.service.create(dto, resolveBusinessId(user, queryBusinessId));
  }

  @Patch('reorder')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  reorder(
    @Body() dto: ReorderCategoriesDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') queryBusinessId?: string,
  ) {
    const ids = dto.categoryIds || dto.ids || [];
    return this.service.reorder(resolveBusinessId(user, queryBusinessId), ids);
  }

  @Post(':id/move-products')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  moveProducts(
    @Param('id') id: string,
    @Body() dto: MoveCategoryProductsDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') queryBusinessId?: string,
  ) {
    return this.service.moveProducts(
      id,
      dto.targetCategoryId,
      resolveBusinessId(user, queryBusinessId),
    );
  }

  @Patch(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') queryBusinessId?: string,
  ) {
    return this.service.update(id, dto, resolveBusinessId(user, queryBusinessId));
  }

  @Put(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  updatePut(
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') queryBusinessId?: string,
  ) {
    return this.service.update(id, dto, resolveBusinessId(user, queryBusinessId));
  }

  @Delete(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  remove(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') queryBusinessId?: string,
  ) {
    return this.service.remove(id, resolveBusinessId(user, queryBusinessId));
  }
}
