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
import { SuperAdminService } from './superadmin.service';
import { SuperAdminGuard } from '../../common/guards/superadmin.guard';
import { CreateBusinessSuperAdminDto } from './dto/create-business-superadmin.dto';
import { OrdersMetricsQueryDto } from './dto/orders-metrics-query.dto';

@Controller('superadmin')
@UseGuards(SuperAdminGuard)
export class SuperAdminController {
  constructor(private readonly superAdminService: SuperAdminService) {}

  // ==========================================
  // NEGOCIOS
  // ==========================================

  @Get('businesses')
  async getBusinesses() {
    return this.superAdminService.getBusinesses();
  }

  @Get('businesses/:id')
  async getBusinessById(@Param('id') id: string) {
    return this.superAdminService.getBusinessById(id);
  }

  @Patch('businesses/:id/toggle')
  async toggleBusiness(@Param('id') id: string) {
    return this.superAdminService.toggleBusiness(id);
  }

  @Post('businesses')
  async createBusiness(@Body() dto: CreateBusinessSuperAdminDto) {
    return this.superAdminService.createBusiness(dto);
  }

  // ==========================================
  // REPARTIDORES
  // ==========================================

  @Get('riders/active')
  async getActiveRiders() {
    return this.superAdminService.getActiveRiders();
  }

  @Get('riders')
  async getRiders() {
    return this.superAdminService.getRiders();
  }

  @Patch('riders/:id/toggle')
  async toggleRider(@Param('id') id: string) {
    return this.superAdminService.toggleRider(id);
  }

  // ==========================================
  // MÉTRICAS
  // ==========================================

  @Get('metrics')
  async getGlobalMetrics() {
    return this.superAdminService.getGlobalMetrics();
  }

  @Get('metrics/orders')
  async getOrdersMetrics(@Query() query: OrdersMetricsQueryDto) {
    return this.superAdminService.getOrdersMetrics(query);
  }

  // ==========================================
  // LOGS / ACTIVIDAD
  // ==========================================

  @Get('logs')
  async getRecentLogs() {
    return this.superAdminService.getRecentLogs();
  }
}
