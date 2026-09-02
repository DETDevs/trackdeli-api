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
import { CustomersService } from './customers.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { UserRole } from '@prisma/client';
import { UpdateCustomerLocationDto } from './dto/update-customer-location.dto';

import { CreateLocationConfirmationLinkDto } from './dto/create-location-link.dto';

@Controller()
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  private checkBusinessAccess(user: JwtPayload, businessId: string) {
    if (user.role !== UserRole.SUPERADMIN && user.businessId !== businessId) {
      throw new ForbiddenException('No tienes permiso para acceder a los clientes de este negocio');
    }
  }

  // 1. GET /businesses/:businessId/customers/search?q=XXXX
  @Get(['businesses/:businessId/customers/search', 'businesses/me/customers/search'])
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async search(
    @Param('businessId') paramBusinessId: string,
    @Query('q') query: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const businessId = paramBusinessId || user.businessId;
    if (!businessId) {
      throw new ForbiddenException('Negocio no especificado');
    }
    this.checkBusinessAccess(user, businessId);
    return this.customersService.search(businessId, query);
  }

  // 2. GET /businesses/:businessId/customers/lookup?phone=XXXX
  @Get(['businesses/:businessId/customers/lookup', 'businesses/me/customers/lookup'])
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async lookup(
    @Param('businessId') paramBusinessId: string,
    @Query('phone') phone: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const businessId = paramBusinessId || user.businessId;
    if (!businessId) {
      throw new ForbiddenException('Negocio no especificado');
    }
    this.checkBusinessAccess(user, businessId);
    return this.customersService.lookup(businessId, phone);
  }

  // 3a. POST /customers/location-confirmation-link (Body: { businessId, phone, name } con upsert automático)
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

  // 3b. POST /customers/:id/location-confirmation-link (por ID directo)
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

  // 4. GET /customers/confirm-location/:token (Público, exclusivo de CustomerLocationSession)
  @Get([
    'customers/confirm-location/:token',
    'customers/location-session/:token',
    'confirm-location/:token',
  ])
  @Public()
  async getLocationSession(@Param('token') token: string) {
    return this.customersService.getLocationSession(token);
  }

  // 5. PATCH /customers/:id/location (Público protegido por token o Autenticado)
  @Patch('customers/:id/location')
  @Public()
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
