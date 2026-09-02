import { Body, Controller, Delete, Get, Param, Patch, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UsersService } from './users.service';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateRiderProfileDto } from './dto/update-rider-profile.dto';
import { JoinBusinessDto } from './dto/join-business.dto';

@Controller('users')
export class UsersController {
  constructor(private readonly service: UsersService) {}

  @Post('me/join-business')
  @Roles(UserRole.REPARTIDOR)
  joinBusiness(
    @CurrentUser() user: JwtPayload,
    @Body() dto: JoinBusinessDto,
  ) {
    return this.service.joinBusiness(user.sub, dto.code);
  }

  @Patch('me')
  @Roles(UserRole.REPARTIDOR)
  updateProfile(
    @Body() dto: UpdateRiderProfileDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.updateProfile(user.sub, dto);
  }

  @Post('me/vehicle-photo')
  @Roles(UserRole.REPARTIDOR)
  @UseInterceptors(FileInterceptor('photo'))
  uploadVehiclePhoto(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.uploadVehiclePhoto(user.sub, file);
  }

  @Post('me/profile-photo')
  @Roles(UserRole.REPARTIDOR)
  @UseInterceptors(FileInterceptor('photo'))
  uploadProfilePhoto(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.uploadProfilePhoto(user.sub, file);
  }

  @Get()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  findAll(@CurrentUser() user: JwtPayload) {
    // If superadmin wants to list, we should probably allow businessId as query param,
    // but the prompt explicitly states "Retorna repartidores del businessId del token", 
    // so we strictly use user.businessId for both.
    return this.service.findAllByBusiness(user.businessId);
  }

  @Get(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.findOne(id, user.businessId);
  }

  @Post()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  create(@Body() dto: CreateUserDto, @CurrentUser() user: JwtPayload) {
    return this.service.create(dto, user.businessId);
  }

  @Patch(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.update(id, dto, user.businessId);
  }

  @Delete(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  deactivate(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.deactivate(id, user.businessId, user.sub);
  }

  @Get('health')
  @Public()
  healthCheck() {
    return { status: 'ok', module: 'users' };
  }
}
