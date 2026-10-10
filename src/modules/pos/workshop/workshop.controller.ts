import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  Body,
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
import { WorkshopService } from './workshop.service';
import { UpdateWorkshopVehicleDto } from './dto/update-workshop-vehicle.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller('pos/workshop')
export class WorkshopController {
  constructor(private readonly service: WorkshopService) {}

  /**
   * GET /pos/workshop/vehicles?search=
   * Busca vehículos por placa, cliente o teléfono (máx 20).
   */
  @Get('vehicles')
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
  getVehicles(
    @CurrentUser() user: JwtPayload,
    @Query('search') search?: string,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.getVehicles(businessId, search);
  }

  /**
   * GET /pos/workshop/vehicles/:id
   * Ficha completa del vehículo y su cliente.
   */
  @Get('vehicles/:id')
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
  getVehicleById(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.getVehicleById(businessId, id);
  }

  /**
   * GET /pos/workshop/vehicles/:id/history?page=&limit=
   * Historial de visitas con fecha, kilometraje, técnico, servicios/productos cobrados y total.
   */
  @Get('vehicles/:id/history')
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
  getVehicleHistory(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    const p = page ? parseInt(page, 10) : 1;
    const l = limit ? parseInt(limit, 10) : 20;
    return this.service.getVehicleHistory(businessId, id, p, l);
  }

  /**
   * PATCH /pos/workshop/vehicles/:id
   * Corrige descripción, placa (revalidando unicidad) y cliente. Solo ENCARGADO y SUPERADMIN.
   */
  @Patch('vehicles/:id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  updateVehicle(
    @Param('id') id: string,
    @Body() dto: UpdateWorkshopVehicleDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.updateVehicle(businessId, id, dto, user);
  }

  /**
   * GET /pos/workshop/customers/:id
   * Ficha del cliente con todos sus vehículos registrados.
   */
  @Get('customers/:id')
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
  getCustomerWithVehicles(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.getCustomerWithVehicles(businessId, id);
  }
}
