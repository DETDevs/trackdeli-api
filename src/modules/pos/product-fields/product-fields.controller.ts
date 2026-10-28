import {
  Body,
  Controller,
  Delete,
  Get,
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
import { ProductFieldsService } from './product-fields.service';
import { CreateProductFieldDto } from './dto/create-product-field.dto';
import { UpdateProductFieldDto } from './dto/update-product-field.dto';
import { ReorderProductFieldsDto } from './dto/reorder-product-fields.dto';
import { CreateFieldOptionDto } from './dto/create-field-option.dto';
import { UpdateFieldOptionDto } from './dto/update-field-option.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller('pos/product-fields')
export class ProductFieldsController {
  constructor(private readonly service: ProductFieldsService) {}

  @Get()
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.WAITER, UserRole.SUPERADMIN)
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    // Para cajero o mesero, se devuelven solo activos por defecto a menos que se indique lo contrario
    const isCashierOrWaiter =
      user.role === UserRole.CAJERO || user.role === UserRole.WAITER;
    const onlyActive =
      activeOnly !== undefined ? activeOnly === 'true' : isCashierOrWaiter;
    return this.service.findAll(businessId, onlyActive);
  }

  @Get(':id')
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.WAITER, UserRole.SUPERADMIN)
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.findOne(resolveBusinessId(user, qBid), id);
  }

  @Post()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  create(
    @Body() dto: CreateProductFieldDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.create(resolveBusinessId(user, qBid), dto);
  }

  @Patch('reorder')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  reorder(
    @Body() dto: ReorderProductFieldsDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.reorder(resolveBusinessId(user, qBid), dto.fieldIds);
  }

  @Patch(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProductFieldDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.update(resolveBusinessId(user, qBid), id, dto);
  }

  @Patch(':id/deactivate')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  deactivate(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.deactivate(resolveBusinessId(user, qBid), id);
  }

  @Patch(':id/activate')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  activate(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.activate(resolveBusinessId(user, qBid), id);
  }

  // ========================================================
  // Endpoints de Opciones (Campos tipo LIST)
  // ========================================================

  @Get(':fieldId/options')
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.WAITER, UserRole.SUPERADMIN)
  findOptions(
    @Param('fieldId') fieldId: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    const isCashierOrWaiter =
      user.role === UserRole.CAJERO || user.role === UserRole.WAITER;
    const onlyActive =
      activeOnly !== undefined ? activeOnly === 'true' : isCashierOrWaiter;
    return this.service.findOptions(resolveBusinessId(user, qBid), fieldId, onlyActive);
  }

  @Post(':fieldId/options')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  createOption(
    @Param('fieldId') fieldId: string,
    @Body() dto: CreateFieldOptionDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.createOption(resolveBusinessId(user, qBid), fieldId, dto);
  }

  @Patch(':fieldId/options/:optionId')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  updateOption(
    @Param('fieldId') fieldId: string,
    @Param('optionId') optionId: string,
    @Body() dto: UpdateFieldOptionDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.updateOption(resolveBusinessId(user, qBid), fieldId, optionId, dto);
  }

  @Patch(':fieldId/options/:optionId/deactivate')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  deactivateOption(
    @Param('fieldId') fieldId: string,
    @Param('optionId') optionId: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.deactivateOption(resolveBusinessId(user, qBid), fieldId, optionId);
  }

  @Patch(':fieldId/options/:optionId/activate')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  activateOption(
    @Param('fieldId') fieldId: string,
    @Param('optionId') optionId: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.activateOption(resolveBusinessId(user, qBid), fieldId, optionId);
  }

  @Delete(':fieldId/options/:optionId')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  deleteOption(
    @Param('fieldId') fieldId: string,
    @Param('optionId') optionId: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.deleteOption(resolveBusinessId(user, qBid), fieldId, optionId);
  }
}
