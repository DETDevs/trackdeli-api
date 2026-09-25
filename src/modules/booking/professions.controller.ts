import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { BookingService } from './booking.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SkipMembershipCheck } from '../../common/decorators/skip-membership.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CitasGuard } from '../../common/guards/citas.guard';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { UserRole } from '@prisma/client';
import {
  CreateProfessionDto,
  UpdateProfessionDto,
} from './dto/profession.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, CitasGuard)
@Controller()
export class ProfessionsController {
  constructor(private readonly bookingService: BookingService) {}

  private resolveBusinessId(
    user: JwtPayload,
    paramBusinessId?: string,
  ): string {
    const targetId =
      !paramBusinessId || paramBusinessId === 'me'
        ? user.businessId
        : paramBusinessId;

    if (!targetId) {
      throw new ForbiddenException('Sin negocio asociado');
    }

    if (user.role !== UserRole.SUPERADMIN && user.businessId !== targetId) {
      throw new ForbiddenException(
        'No tienes permiso para gestionar profesiones de este negocio',
      );
    }

    return targetId;
  }

  @Get(['businesses/me/professions', 'businesses/:businessId/professions'])
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
  async getProfessions(
    @CurrentUser() user: JwtPayload,
    @Param('businessId') paramBusinessId?: string,
  ) {
    const businessId = this.resolveBusinessId(user, paramBusinessId);
    return this.bookingService.getProfessions(businessId);
  }

  @Post(['businesses/me/professions', 'businesses/:businessId/professions'])
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async createProfession(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateProfessionDto,
    @Param('businessId') paramBusinessId?: string,
  ) {
    const businessId = this.resolveBusinessId(user, paramBusinessId);
    return this.bookingService.createProfession(businessId, dto);
  }

  @Patch([
    'businesses/me/professions/:id',
    'businesses/:businessId/professions/:id',
    'professions/:id',
  ])
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async updateProfession(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateProfessionDto,
    @Param('businessId') paramBusinessId?: string,
  ) {
    const businessId = this.resolveBusinessId(user, paramBusinessId);
    return this.bookingService.updateProfession(id, businessId, dto);
  }

  @Delete([
    'businesses/me/professions/:id',
    'businesses/:businessId/professions/:id',
    'professions/:id',
  ])
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async deleteProfession(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Param('businessId') paramBusinessId?: string,
  ) {
    const businessId = this.resolveBusinessId(user, paramBusinessId);
    return this.bookingService.deleteProfession(id, businessId);
  }
}
