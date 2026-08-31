import { Body, Controller, ForbiddenException, Get, Param, Patch, Put } from '@nestjs/common';
import { BusinessesService } from './businesses.service';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { SkipMembership } from '../../common/decorators/skip-membership.decorator';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { UpdateBusinessDto } from './dto/update-business.dto';

@Controller('businesses')
export class BusinessesController {
  constructor(private readonly service: BusinessesService) {}

  @Get('me')
  @SkipMembership()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN, UserRole.REPARTIDOR)
  getMyBusiness(@CurrentUser() user: JwtPayload) {
    if (!user.businessId) {
      return null; // Repartidores independientes no tienen negocio
    }
    return this.service.findOne(user.businessId);
  }

  @Patch('me')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  updateMyBusiness(@Body() dto: UpdateBusinessDto, @CurrentUser() user: JwtPayload) {
    return this.service.update(user.businessId, dto);
  }

  @Get(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN, UserRole.REPARTIDOR)
  getBusinessById(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    if (user.role !== UserRole.SUPERADMIN && user.businessId !== id) {
      throw new ForbiddenException('No tienes permiso para ver este negocio');
    }
    return this.service.findOne(id);
  }

  @Patch(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  updateBusinessById(
    @Param('id') id: string,
    @Body() dto: UpdateBusinessDto,
    @CurrentUser() user: JwtPayload,
  ) {
    if (user.role !== UserRole.SUPERADMIN && user.businessId !== id) {
      throw new ForbiddenException('No tienes permiso para editar este negocio');
    }
    return this.service.update(id, dto);
  }

  @Put(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  updateBusinessByIdPut(
    @Param('id') id: string,
    @Body() dto: UpdateBusinessDto,
    @CurrentUser() user: JwtPayload,
  ) {
    if (user.role !== UserRole.SUPERADMIN && user.businessId !== id) {
      throw new ForbiddenException('No tienes permiso para editar este negocio');
    }
    return this.service.update(id, dto);
  }

  @Get('health')
  @Public()
  healthCheck() {
    return { status: 'ok', module: 'businesses' };
  }
}

