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

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, CitasGuard)
@Controller()
export class BookingPanelController {
  constructor(private readonly bookingService: BookingService) {}

  private checkBusinessAccess(user: JwtPayload, businessId: string) {
    if (user.role !== UserRole.SUPERADMIN && user.businessId !== businessId) {
      throw new ForbiddenException(
        'No tienes permiso para gestionar las citas de este negocio',
      );
    }
  }

  // =========================================================================
  // Agenda y Operativa de Citas (ENCARGADO, CAJERO, SUPERADMIN)
  // =========================================================================

  /**
   * Listado/agenda de citas del negocio.
   * GET /businesses/:id/appointments?status=&date=&serviceId=
   */
  @Get('businesses/:id/appointments')
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
  async getAppointments(
    @Param('id') businessId: string,
    @CurrentUser() user: JwtPayload,
    @Query('status') status?: AppointmentStatus,
    @Query('date') date?: string,
    @Query('serviceId') serviceId?: string,
  ) {
    this.checkBusinessAccess(user, businessId);
    return this.bookingService.getBusinessAppointments(businessId, {
      status,
      date,
      serviceId,
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

  // =========================================================================
  // Configuración de Servicios (ENCARGADO, SUPERADMIN)
  // =========================================================================

  @Get('businesses/:id/booking/services')
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
  async getServices(
    @Param('id') businessId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    this.checkBusinessAccess(user, businessId);
    return this.bookingService.getServices(businessId);
  }

  @Post('businesses/:id/booking/services')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async createService(
    @Param('id') businessId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateBookingServiceDto,
  ) {
    this.checkBusinessAccess(user, businessId);
    return this.bookingService.createService(businessId, dto);
  }

  @Patch('booking/services/:id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async updateService(
    @Param('id') id: string,
    @Body() dto: UpdateBookingServiceDto,
  ) {
    return this.bookingService.updateService(id, dto);
  }

  @Delete('booking/services/:id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async deleteService(@Param('id') id: string) {
    return this.bookingService.deleteService(id);
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
