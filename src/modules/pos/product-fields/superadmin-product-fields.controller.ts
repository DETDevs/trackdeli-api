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
import { SuperAdminGuard } from '../../../common/guards/superadmin.guard';
import { ProductFieldsService } from './product-fields.service';
import { CreateProductFieldDto } from './dto/create-product-field.dto';
import { UpdateProductFieldDto } from './dto/update-product-field.dto';
import { ReorderProductFieldsDto } from './dto/reorder-product-fields.dto';

@Controller('superadmin/businesses/:businessId/product-fields')
@UseGuards(SuperAdminGuard)
export class SuperAdminProductFieldsController {
  constructor(private readonly service: ProductFieldsService) {}

  @Get()
  findAll(
    @Param('businessId') businessId: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    return this.service.findAll(businessId, activeOnly === 'true');
  }

  @Get(':id')
  findOne(
    @Param('businessId') businessId: string,
    @Param('id') id: string,
  ) {
    return this.service.findOne(businessId, id);
  }

  @Post()
  create(
    @Param('businessId') businessId: string,
    @Body() dto: CreateProductFieldDto,
  ) {
    return this.service.create(businessId, dto);
  }

  @Patch('reorder')
  reorder(
    @Param('businessId') businessId: string,
    @Body() dto: ReorderProductFieldsDto,
  ) {
    return this.service.reorder(businessId, dto.fieldIds);
  }

  @Patch(':id')
  update(
    @Param('businessId') businessId: string,
    @Param('id') id: string,
    @Body() dto: UpdateProductFieldDto,
  ) {
    return this.service.update(businessId, id, dto);
  }

  @Patch(':id/deactivate')
  deactivate(
    @Param('businessId') businessId: string,
    @Param('id') id: string,
  ) {
    return this.service.deactivate(businessId, id);
  }

  @Patch(':id/activate')
  activate(
    @Param('businessId') businessId: string,
    @Param('id') id: string,
  ) {
    return this.service.activate(businessId, id);
  }
}
