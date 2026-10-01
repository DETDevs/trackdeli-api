import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IndustriesService } from './industries.service';
import { SuperAdminGuard } from '../../common/guards/superadmin.guard';
import { CreateIndustryDto } from './dto/create-industry.dto';
import { UpdateIndustryDto } from './dto/update-industry.dto';
import { CreateFieldTemplateDto } from './dto/create-field-template.dto';
import { UpdateFieldTemplateDto } from './dto/update-field-template.dto';

@Controller('superadmin/industries')
@UseGuards(SuperAdminGuard)
export class SuperAdminIndustriesController {
  constructor(private readonly service: IndustriesService) {}

  @Get()
  findAll() {
    return this.service.findAllForSuperAdmin();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateIndustryDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateIndustryDto) {
    return this.service.update(id, dto);
  }

  @Get(':id/fields')
  getFields(@Param('id') id: string) {
    return this.service.getFieldTemplates(id);
  }

  @Post(':id/fields')
  addField(@Param('id') id: string, @Body() dto: CreateFieldTemplateDto) {
    return this.service.addFieldTemplate(id, dto);
  }

  @Patch(':id/fields/:fieldId')
  updateField(
    @Param('id') id: string,
    @Param('fieldId') fieldId: string,
    @Body() dto: UpdateFieldTemplateDto,
  ) {
    return this.service.updateFieldTemplate(id, fieldId, dto);
  }

  @Delete(':id/fields/:fieldId')
  removeField(
    @Param('id') id: string,
    @Param('fieldId') fieldId: string,
  ) {
    return this.service.removeFieldTemplate(id, fieldId);
  }
}
