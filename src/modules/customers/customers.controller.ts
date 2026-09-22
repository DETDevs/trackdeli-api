import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CustomersService } from './customers.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { SkipMembershipCheck } from '../../common/decorators/skip-membership.decorator';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { UserRole } from '@prisma/client';
import { UpdateCustomerLocationDto } from './dto/update-customer-location.dto';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CreateLocationConfirmationLinkDto } from './dto/create-location-link.dto';

@SkipMembershipCheck()
@Controller()
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  private checkBusinessAccess(user: JwtPayload, businessId: string) {
    if (user.role !== UserRole.SUPERADMIN && user.businessId !== businessId) {
      throw new ForbiddenException('No tienes permiso para acceder a los clientes de este negocio');
    }
  }

  @Get([
    'businesses/:businessId/clients',
    'businesses/me/clients',
    'businesses/:businessId/customers',
    'businesses/me/customers',
    'clients',
  ])
  @Roles(UserRole.CAJERO, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async findAll(
    @CurrentUser() user: JwtPayload,
    @Query('q') query?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Param('businessId') paramBusinessId?: string,
  ) {
    const businessId =
      paramBusinessId && paramBusinessId !== 'me'
        ? paramBusinessId
        : user.businessId;
    if (!businessId) {
      throw new ForbiddenException('Negocio no especificado');
    }
    this.checkBusinessAccess(user, businessId);
    return this.customersService.findAll(businessId, { q: query, page, limit });
  }

  @Get([
    'businesses/:businessId/clients/:id/history',
    'businesses/me/clients/:id/history',
    'businesses/:businessId/customers/:id/history',
    'businesses/me/customers/:id/history',
    'clients/:id/history',
  ])
  @Roles(UserRole.CAJERO, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async getHistory(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Param('businessId') paramBusinessId?: string,
  ) {
    const businessId =
      paramBusinessId && paramBusinessId !== 'me'
        ? paramBusinessId
        : user.businessId;
    if (!businessId) {
      throw new ForbiddenException('Negocio no especificado');
    }
    this.checkBusinessAccess(user, businessId);
    return this.customersService.getHistory(businessId, id);
  }

  @Get([
    'businesses/:businessId/clients/:id',
    'businesses/me/clients/:id',
    'businesses/:businessId/customers/:id',
    'businesses/me/customers/:id',
    'clients/:id',
  ])
  @Roles(UserRole.CAJERO, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async findOne(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Param('businessId') paramBusinessId?: string,
  ) {
    const businessId =
      paramBusinessId && paramBusinessId !== 'me'
        ? paramBusinessId
        : user.businessId;
    if (!businessId) {
      throw new ForbiddenException('Negocio no especificado');
    }
    this.checkBusinessAccess(user, businessId);
    return this.customersService.findById(businessId, id);
  }

  @Patch([
    'businesses/:businessId/clients/:id',
    'businesses/me/clients/:id',
    'businesses/:businessId/customers/:id',
    'businesses/me/customers/:id',
    'clients/:id',
  ])
  @Roles(UserRole.CAJERO, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async updateCustomer(
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
    @CurrentUser() user: JwtPayload,
    @Param('businessId') paramBusinessId?: string,
  ) {
    const businessId =
      paramBusinessId && paramBusinessId !== 'me'
        ? paramBusinessId
        : user.businessId;
    if (!businessId) {
      throw new ForbiddenException('Negocio no especificado');
    }
    this.checkBusinessAccess(user, businessId);
    return this.customersService.updateCustomer(businessId, id, dto);
  }

  @Get([
    'businesses/:businessId/customers/search',
    'businesses/me/customers/search',
    'pos/customers/search',
    'customers/search',
  ])
  @Roles(UserRole.CAJERO, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async search(
    @Query('q') query: string,
    @CurrentUser() user: JwtPayload,
    @Param('businessId') paramBusinessId?: string,
  ) {
    const businessId =
      paramBusinessId && paramBusinessId !== 'me'
        ? paramBusinessId
        : user.businessId;
    if (!businessId) {
      throw new ForbiddenException('Negocio no especificado');
    }
    this.checkBusinessAccess(user, businessId);
    return this.customersService.search(businessId, query);
  }

  @Get([
    'businesses/:businessId/customers/lookup',
    'businesses/me/customers/lookup',
    'pos/customers/lookup',
    'customers/lookup',
  ])
  @Roles(UserRole.CAJERO, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async lookup(
    @Query('phone') phone: string,
    @CurrentUser() user: JwtPayload,
    @Param('businessId') paramBusinessId?: string,
  ) {
    const businessId =
      paramBusinessId && paramBusinessId !== 'me'
        ? paramBusinessId
        : user.businessId;
    if (!businessId) {
      throw new ForbiddenException('Negocio no especificado');
    }
    this.checkBusinessAccess(user, businessId);
    return this.customersService.lookup(businessId, phone);
  }

  @Post([
    'businesses/:businessId/clients',
    'businesses/me/clients',
    'businesses/:businessId/customers',
    'businesses/me/customers',
    'pos/customers',
    'customers',
  ])
  @Roles(UserRole.CAJERO, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async create(
    @Body() dto: CreateCustomerDto,
    @CurrentUser() user: JwtPayload,
    @Param('businessId') paramBusinessId?: string,
  ) {
    const businessId =
      paramBusinessId && paramBusinessId !== 'me'
        ? paramBusinessId
        : dto.businessId || user.businessId;
    if (!businessId) {
      throw new ForbiddenException('Negocio no especificado');
    }
    this.checkBusinessAccess(user, businessId);
    return this.customersService.create(businessId, dto);
  }

  @Post('customers/location-confirmation-link')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async createConfirmationLinkByData(
    @Body() dto: CreateLocationConfirmationLinkDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.customersService.createLocationConfirmationLinkByData(
      dto,
      user.businessId,
      user.role,
    );
  }

  @Post('customers/:id/location-confirmation-link')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async createConfirmationLink(
    @Param('id') customerId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.customersService.createLocationConfirmationLink(
      customerId,
      user.businessId,
      user.role,
    );
  }

  @Get([
    'customers/confirm-location/:token',
    'customers/location-session/:token',
    'confirm-location/:token',
  ])
  @Public()
  async getLocationSession(@Param('token') token: string) {
    return this.customersService.getLocationSession(token);
  }

  @Patch('customers/:id/location')
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async updateLocation(
    @Param('id') customerId: string,
    @Body() dto: UpdateCustomerLocationDto,
    @Query('token') queryToken?: string,
    @Headers('x-location-token') headerToken?: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const token = queryToken || headerToken;
    return this.customersService.updateLocation(
      customerId,
      dto,
      token,
      user?.role,
      user?.businessId,
    );
  }
}

