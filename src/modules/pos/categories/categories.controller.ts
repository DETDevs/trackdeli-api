import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { resolveBusinessId } from '../pos.utils';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller('pos/categories')
export class CategoriesController {
  constructor(private readonly service: CategoriesService) {}

  @Get()
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') queryBusinessId?: string,
  ) {
    return this.service.findAll(resolveBusinessId(user, queryBusinessId));
  }

  @Post()
  create(
    @Body() dto: CreateCategoryDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') queryBusinessId?: string,
  ) {
    return this.service.create(dto, resolveBusinessId(user, queryBusinessId));
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') queryBusinessId?: string,
  ) {
    return this.service.update(id, dto, resolveBusinessId(user, queryBusinessId));
  }

  @Put(':id')
  updatePut(
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') queryBusinessId?: string,
  ) {
    return this.service.update(id, dto, resolveBusinessId(user, queryBusinessId));
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') queryBusinessId?: string,
  ) {
    return this.service.remove(id, resolveBusinessId(user, queryBusinessId));
  }
}
