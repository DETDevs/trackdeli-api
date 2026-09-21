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
  CreateSpecialistDto,
  UpdateSpecialistDto,
} from './dto/specialist.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, CitasGuard)
@Controller()
export class SpecialistsController {
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
        'No tienes permiso para gestionar especialistas de este negocio',
      );
    }

    return targetId;
  }

  @Post(['businesses/me/specialists', 'businesses/:businessId/specialists'])
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async createSpecialist(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateSpecialistDto,
    @Param('businessId') paramBusinessId?: string,
  ) {
    const businessId = this.resolveBusinessId(user, paramBusinessId);
    return this.bookingService.createSpecialist(businessId, dto);
  }

  @Get(['businesses/me/specialists', 'businesses/:businessId/specialists'])
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
  async getSpecialists(
    @CurrentUser() user: JwtPayload,
    @Param('businessId') paramBusinessId?: string,
  ) {
    const businessId = this.resolveBusinessId(user, paramBusinessId);
    return this.bookingService.getSpecialists(businessId);
  }

  @Patch([
    'businesses/me/specialists/:id',
    'businesses/:businessId/specialists/:id',
    'specialists/:id',
  ])
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async updateSpecialist(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateSpecialistDto,
    @Param('businessId') paramBusinessId?: string,
  ) {
    const businessId = this.resolveBusinessId(user, paramBusinessId);
    const isSuperAdmin = user.role === UserRole.SUPERADMIN;
    return this.bookingService.updateSpecialist(
      id,
      businessId,
      dto,
      isSuperAdmin,
    );
  }

  @Delete([
    'businesses/me/specialists/:id',
    'businesses/:businessId/specialists/:id',
    'specialists/:id',
  ])
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async deleteSpecialist(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Param('businessId') paramBusinessId?: string,
  ) {
    const businessId = this.resolveBusinessId(user, paramBusinessId);
    const isSuperAdmin = user.role === UserRole.SUPERADMIN;
    return this.bookingService.deleteSpecialist(
      id,
      businessId,
      isSuperAdmin,
    );
  }
}
