import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SuperAdminService } from './superadmin.service';
import { SuperAdminGuard } from '../../common/guards/superadmin.guard';
import { CreateBusinessSuperAdminDto } from './dto/create-business-superadmin.dto';
import { OrdersMetricsQueryDto } from './dto/orders-metrics-query.dto';
import { CreateMembershipDto } from './dto/create-membership.dto';
import { UpdateMembershipDto } from './dto/update-membership.dto';
import { MembershipsQueryDto } from './dto/memberships-query.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { CommissionsService } from '../commissions/commissions.service';
import { BusinessesService } from '../businesses/businesses.service';
import { UpdateBusinessDto } from '../businesses/dto/update-business.dto';

@Controller('superadmin')
@UseGuards(SuperAdminGuard)
export class SuperAdminController {
  constructor(
    private readonly superAdminService: SuperAdminService,
    private readonly commissionsService: CommissionsService,
    private readonly businessesService: BusinessesService,
  ) {}

  // ==========================================
  // NEGOCIOS
  // ==========================================

  @Get('businesses')
  async getBusinesses() {
    return this.superAdminService.getBusinesses();
  }

  @Get('businesses/:id/memberships')
  async getBusinessMemberships(@Param('id') id: string) {
    return this.superAdminService.getBusinessMemberships(id);
  }

  @Get('businesses/:id')
  async getBusinessById(@Param('id') id: string) {
    return this.superAdminService.getBusinessById(id);
  }

  @Patch('businesses/:id')
  async updateBusiness(
    @Param('id') id: string,
    @Body() dto: UpdateBusinessDto,
  ) {
    return this.businessesService.update(id, dto);
  }

  @Put('businesses/:id')
  async updateBusinessPut(
    @Param('id') id: string,
    @Body() dto: UpdateBusinessDto,
  ) {
    return this.businessesService.update(id, dto);
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
  // MEMBRESÍAS
  // ==========================================

  @Get('memberships/expiring')
  async getExpiringMemberships() {
    return this.superAdminService.getExpiringMemberships();
  }

  @Get('memberships')
  async getMemberships(@Query() query: MembershipsQueryDto) {
    return this.superAdminService.getMemberships(query);
  }

  @Post('memberships')
  async createMembership(
    @Body() dto: CreateMembershipDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.superAdminService.createMembership(dto, user.sub);
  }

  @Post('memberships/:id/proof')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    }),
  )
  async uploadPaymentProof(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.superAdminService.uploadPaymentProof(id, file);
  }

  @Patch('memberships/:id')
  async updateMembership(
    @Param('id') id: string,
    @Body() dto: UpdateMembershipDto,
  ) {
    return this.superAdminService.updateMembership(id, dto);
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

  // ==========================================
  // COMISIONES Y ESTADOS DE CUENTA
  // ==========================================

  @Get('commissions')
  async getCommissions(
    @Query('month') month?: string,
    @Query('year') year?: string,
    @Query('businessId') businessId?: string,
  ) {
    return this.commissionsService.getAllCommissions(
      month ? parseInt(month) : undefined,
      year ? parseInt(year) : undefined,
      businessId,
    );
  }

  @Post('statements/generate')
  async generateStatements(
    @Body() dto: { month: number; year: number },
  ) {
    return this.commissionsService.generateMonthlyStatements(dto.month, dto.year);
  }

  @Patch('statements/:id/pay')
  async payStatement(
    @Param('id') id: string,
    @Body() dto: { paidAmount?: number; notes?: string },
  ) {
    return this.commissionsService.payStatement(id, dto);
  }

  @Get('debtors')
  async getDebtors() {
    return this.commissionsService.getDebtors();
  }
}
