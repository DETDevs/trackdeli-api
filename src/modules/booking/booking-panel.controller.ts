import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { BookingService } from './booking.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SkipMembershipCheck } from '../../common/decorators/skip-membership.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CitasGuard } from '../../common/guards/citas.guard';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { AppointmentStatus, UserRole } from '@prisma/client';
import {
  CreateBookingServiceDto,
  UpdateBookingServiceDto,
} from './dto/booking-service.dto';
import { SaveSchedulesDto } from './dto/save-schedules.dto';
import { UpdateBookingSettingsDto } from './dto/update-booking-settings.dto';
import { DeclineAppointmentDto } from './dto/decline-appointment.dto';
import { ReassignSpecialistDto } from './dto/reassign-specialist.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, CitasGuard)
@Controller()
export class BookingPanelController {
  constructor(private readonly bookingService: BookingService) {}

  private checkBusinessAccess(user: JwtPayload, businessId: string) {
    const targetBusinessId = businessId === 'me' ? user.businessId : businessId;
    if (user.role !== UserRole.SUPERADMIN && user.businessId !== targetBusinessId) {
      throw new ForbiddenException(
        'No tienes permiso para gestionar las citas de este negocio',
      );
    }
  }

  // =========================================================================
  // Agenda y Operativa de Citas (ENCARGADO, CAJERO, SUPERADMIN)
  // =========================================================================

  /**
   * Listado/agenda de citas del negocio con filtros y paginación.
   * GET /businesses/:id/appointments?status=&date=&serviceId=&specialistId=&page=&limit=
   * GET /businesses/me/appointments
   * GET /appointments
   */
  @Get([
    'businesses/:id/appointments',
    'businesses/me/appointments',
    'appointments',
  ])
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
  async getAppointments(
    @Param('id') paramBusinessId: string | undefined,
    @CurrentUser() user: JwtPayload,
    @Query('status') status?: AppointmentStatus,
    @Query('date') date?: string,
    @Query('serviceId') serviceId?: string,
    @Query('specialistId') specialistId?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    const businessId =
      paramBusinessId && paramBusinessId !== 'me'
        ? paramBusinessId
        : user.businessId;
    if (!businessId) {
      throw new ForbiddenException('Negocio no especificado');
    }
    this.checkBusinessAccess(user, businessId);
    return this.bookingService.getBusinessAppointments(businessId, {
      status,
      date,
      serviceId,
      specialistId,
      page,
      limit,
    });
  }

  /**
   * Aprobar cita y generar enlace WhatsApp pre-armado.
   * PATCH /appointments/:id/approve
   */
  @Patch('appointments/:id/approve')
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
  async approveAppointment(@Param('id') id: string) {
    return this.bookingService.approveAppointment(id);
  }

  /**
   * Rechazar cita.
   * PATCH /appointments/:id/decline
   */
  @Patch('appointments/:id/decline')
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
  async declineAppointment(
    @Param('id') id: string,
    @Body() dto: DeclineAppointmentDto,
  ) {
    return this.bookingService.declineAppointment(id, dto?.reason);
  }

  /**
   * Cancelar cita confirmada por el negocio (no bloquea, advierte si es tardía).
   * PATCH /appointments/:id/cancel
   */
  @Patch('appointments/:id/cancel')
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
  async cancelAppointment(@Param('id') id: string) {
    return this.bookingService.cancelAppointmentByBusiness(id);
  }

  /**
   * Marcar cita como completada.
   * PATCH /appointments/:id/complete
   */
  @Patch('appointments/:id/complete')
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
  async completeAppointment(@Param('id') id: string) {
    return this.bookingService.completeAppointment(id);
  }

  /**
   * Marcar cita como no-show.
   * PATCH /appointments/:id/no-show
   */
  @Patch('appointments/:id/no-show')
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
  async markNoShow(@Param('id') id: string) {
    return this.bookingService.markNoShow(id);
  }

  /**
   * Reasignar especialista para una cita existente.
   * PATCH /businesses/me/appointments/:id/specialist
   * PATCH /businesses/:businessId/appointments/:id/specialist
   * PATCH /appointments/:id/specialist
   */
  @Patch([
    'businesses/me/appointments/:id/specialist',
    'businesses/:businessId/appointments/:id/specialist',
    'appointments/:id/specialist',
  ])
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
  async reassignSpecialist(
    @Param('id') appointmentId: string,
    @Param('businessId') paramBusinessId: string | undefined,
    @CurrentUser() user: JwtPayload,
    @Body() dto: ReassignSpecialistDto,
  ) {
    const businessId =
      paramBusinessId && paramBusinessId !== 'me'
        ? paramBusinessId
        : user.businessId;
    if (!businessId) {
      throw new ForbiddenException('Sin negocio asociado');
    }
    this.checkBusinessAccess(user, businessId);
    return this.bookingService.reassignAppointmentSpecialist(
      appointmentId,
      businessId,
      dto.specialistId,
    );
  }

  // =========================================================================
  // Configuración de Servicios (ENCARGADO, SUPERADMIN)
  // =========================================================================

  @Get([
    'businesses/:id/booking/services',
    'businesses/me/booking/services',
    'businesses/:id/services',
    'businesses/me/services',
  ])
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
  async getServices(
    @Param('id') paramBusinessId: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    const businessId =
      paramBusinessId && paramBusinessId !== 'me'
        ? paramBusinessId
        : user.businessId;
    if (!businessId) {
      throw new ForbiddenException('Sin negocio asociado');
    }
    this.checkBusinessAccess(user, businessId);
    return this.bookingService.getServices(businessId);
  }

  @Post([
    'businesses/:id/booking/services',
    'businesses/me/booking/services',
    'businesses/:id/services',
    'businesses/me/services',
  ])
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async createService(
    @Param('id') paramBusinessId: string | undefined,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateBookingServiceDto,
  ) {
    const businessId =
      paramBusinessId && paramBusinessId !== 'me'
        ? paramBusinessId
        : user.businessId;
    if (!businessId) {
      throw new ForbiddenException('Sin negocio asociado');
    }
    this.checkBusinessAccess(user, businessId);
    return this.bookingService.createService(businessId, dto);
  }

  @Patch([
    'booking/services/:id',
    'businesses/:id/services/:serviceId',
    'businesses/me/services/:id',
    'services/:id',
  ])
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async updateService(
    @Param('id') id: string,
    @Param('serviceId') serviceId: string | undefined,
    @Body() dto: UpdateBookingServiceDto,
  ) {
    const targetId = serviceId || id;
    return this.bookingService.updateService(targetId, dto);
  }

  @Delete([
    'booking/services/:id',
    'businesses/:id/services/:serviceId',
    'businesses/me/services/:id',
    'services/:id',
  ])
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async deleteService(
    @Param('id') id: string,
    @Param('serviceId') serviceId: string | undefined,
  ) {
    const targetId = serviceId || id;
    return this.bookingService.deleteService(targetId);
  }

  // =========================================================================
  // Horarios de Disponibilidad (ENCARGADO, SUPERADMIN)
  // =========================================================================

  @Get('businesses/:id/booking/schedules')
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
  async getSchedules(
    @Param('id') businessId: string,
    @CurrentUser() user: JwtPayload,
    @Query('serviceId') serviceId?: string,
  ) {
    this.checkBusinessAccess(user, businessId);
    return this.bookingService.getSchedules(businessId, serviceId);
  }

  @Put('businesses/:id/booking/schedules')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async saveSchedules(
    @Param('id') businessId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: SaveSchedulesDto,
  ) {
    this.checkBusinessAccess(user, businessId);
    return this.bookingService.saveSchedules(businessId, dto);
  }

  // =========================================================================
  // Ajustes de Citas del Negocio (ENCARGADO, SUPERADMIN)
  // =========================================================================

  @Get('businesses/:id/booking/settings')
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
  async getSettings(
    @Param('id') businessId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    this.checkBusinessAccess(user, businessId);
    return this.bookingService.getSettings(businessId);
  }

  @Patch('businesses/:id/booking/settings')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async updateSettings(
    @Param('id') businessId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateBookingSettingsDto,
  ) {
    this.checkBusinessAccess(user, businessId);
    return this.bookingService.updateSettings(businessId, dto);
  }
}
