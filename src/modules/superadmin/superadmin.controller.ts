import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
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

import { LatencyDiagnosticsService } from './latency-diagnostics.service';
import { ClientVersionService } from '../client-version/client-version.service';
import { UpdateClientVersionDto } from '../client-version/dto/update-client-version.dto';
import { GetClientVersionQueryDto } from '../client-version/dto/get-client-version.dto';
import { DEFAULT_PLATFORM } from '../client-version/client-version.constants';
import { UpdateDeviceDto } from '../pos/devices/dto/update-device.dto';
import { UpdatePosSubscriptionDto } from '../pos/devices/dto/update-pos-subscription.dto';

@Controller('superadmin')
@UseGuards(SuperAdminGuard)
export class SuperAdminController {
  constructor(
    private readonly superAdminService: SuperAdminService,
    private readonly commissionsService: CommissionsService,
    private readonly businessesService: BusinessesService,
    private readonly latencyDiagnosticsService: LatencyDiagnosticsService,
    private readonly clientVersionService: ClientVersionService,
  ) {}

  @Get('diagnostics/latency')
  async getLatencyDiagnostics() {
    return this.latencyDiagnosticsService.getDiagnostics();
  }

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
    return this.superAdminService.updateBusiness(id, dto);
  }

  @Put('businesses/:id')
  async updateBusinessPut(
    @Param('id') id: string,
    @Body() dto: UpdateBusinessDto,
  ) {
    return this.superAdminService.updateBusiness(id, dto);
  }

  @Patch('businesses/:id/toggle')
  async toggleBusiness(@Param('id') id: string) {
    return this.superAdminService.toggleBusiness(id);
  }

  @Post('businesses')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async createBusiness(
    @Body() dto: CreateBusinessSuperAdminDto,
    @CurrentUser() user?: JwtPayload,
  ) {
    const creatorId = user?.sub || 'system-superadmin';
    return this.superAdminService.createBusiness(dto, creatorId);
  }

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
      limits: { fileSize: 5 * 1024 * 1024 },
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

  @Get('metrics')
  async getGlobalMetrics() {
    return this.superAdminService.getGlobalMetrics();
  }

  @Get('metrics/orders')
  async getOrdersMetrics(@Query() query: OrdersMetricsQueryDto) {
    return this.superAdminService.getOrdersMetrics(query);
  }

  @Get('logs')
  async getRecentLogs() {
    return this.superAdminService.getRecentLogs();
  }

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

  @Get('businesses/:id/user-quota')
  async getUserQuota(@Param('id') id: string) {
    return this.superAdminService.getBusinessById(id).then(b => b.userUsage);
  }

  @Patch('businesses/:id/user-quota')
  async updateUserQuota(@Param('id') id: string, @Body() dto: { extraUserSlots: number }) {
    return this.superAdminService.updateUserQuota(id, dto.extraUserSlots);
  }

  @Get('client-version')
  async getClientVersion(@Query() query: GetClientVersionQueryDto) {
    const platform = query?.platform || DEFAULT_PLATFORM;
    return this.clientVersionService.getSettingDetails(platform);
  }

  @Patch('client-version')
  async updateClientVersion(
    @Body() dto: UpdateClientVersionDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: any,
  ) {
    const platform = dto.platform || DEFAULT_PLATFORM;
    const ipAddress = req?.ip || req?.connection?.remoteAddress;
    return this.clientVersionService.setMinVersion({
      platform,
      minVersion: dto.minVersion,
      userId: user.sub,
      userRole: user.role,
      businessId: user.businessId,
      reason: dto.reason,
      ipAddress,
    });
  }

  @Put('client-version')
  async updateClientVersionPut(
    @Body() dto: UpdateClientVersionDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: any,
  ) {
    return this.updateClientVersion(dto, user, req);
  }

  @Get('businesses/:id/devices')
  async getBusinessDevices(@Param('id') id: string) {
    return this.superAdminService.getBusinessDevices(id);
  }

  @Patch('businesses/:id/devices/:deviceId')
  async updateBusinessDevice(
    @Param('id') id: string,
    @Param('deviceId') deviceId: string,
    @Body() dto: UpdateDeviceDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.superAdminService.updateBusinessDevice(id, deviceId, dto, user);
  }

  @Get('businesses/:id/web-devices')
  async getBusinessWebDevices(@Param('id') id: string) {
    return this.superAdminService.getBusinessWebDevices(id);
  }

  @Patch('businesses/:id/web-devices/:deviceId')
  async updateBusinessWebDevice(
    @Param('id') id: string,
    @Param('deviceId') deviceId: string,
    @Body() dto: UpdateDeviceDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.superAdminService.updateBusinessWebDevice(id, deviceId, dto, user);
  }

  @Patch('businesses/:id/pos-subscription')
  async updatePosSubscription(
    @Param('id') id: string,
    @Body() dto: UpdatePosSubscriptionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.superAdminService.updatePosSubscription(id, dto, user);
  }

  @Post('businesses/:id/pos-subscription/extend-trial')
  async extendTrial(
    @Param('id') id: string,
    @Body() body: { hours?: number },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.superAdminService.updatePosSubscription(
      id,
      { trialAction: 'extend', extendHours: body?.hours },
      user,
    );
  }

  @Post('businesses/:id/pos-subscription/reset-trial')
  async resetTrial(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.superAdminService.updatePosSubscription(
      id,
      { trialAction: 'reset' },
      user,
    );
  }

  @Post('businesses/:id/pos-subscription/terminate-trial')
  async terminateTrial(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.superAdminService.updatePosSubscription(
      id,
      { trialAction: 'terminate' },
      user,
    );
  }
}

