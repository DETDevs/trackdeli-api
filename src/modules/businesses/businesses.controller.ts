import { Body, Controller, ForbiddenException, Get, Param, Patch, Put } from '@nestjs/common';
import { BusinessesService } from './businesses.service';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { SkipMembership } from '../../common/decorators/skip-membership.decorator';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { UpdateBusinessDto } from './dto/update-business.dto';
import { UpdateBusinessSlugDto } from './dto/update-business-slug.dto';

@Controller('businesses')
export class BusinessesController {
  constructor(private readonly service: BusinessesService) {}

  @Get('me')
  @SkipMembership()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN, UserRole.REPARTIDOR, UserRole.CAJERO)
  getMyBusiness(@CurrentUser() user: JwtPayload) {
    if (!user.businessId) {
      return null;
    }
    return this.service.findOne(user.businessId);
  }

  @Patch('me')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  updateMyBusiness(@Body() dto: UpdateBusinessDto, @CurrentUser() user: JwtPayload) {
    return this.service.update(user.businessId, dto);
  }

  @Patch('me/slug')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  updateMySlug(@Body() dto: UpdateBusinessSlugDto, @CurrentUser() user: JwtPayload) {
    if (!user.businessId) {
      throw new ForbiddenException('Usuario sin negocio asignado');
    }
    return this.service.updateSlug(user.businessId, dto.slug);
  }

  @Get(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN, UserRole.REPARTIDOR, UserRole.CAJERO)
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

  @Patch(':id/slug')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  updateBusinessSlugById(
    @Param('id') id: string,
    @Body() dto: UpdateBusinessSlugDto,
    @CurrentUser() user: JwtPayload,
  ) {
    if (user.role !== UserRole.SUPERADMIN && user.businessId !== id) {
      throw new ForbiddenException('No tienes permiso para editar este negocio');
    }
    return this.service.updateSlug(id, dto.slug);
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

