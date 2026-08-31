import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ClientsService } from './clients.service';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { UserRole } from '@prisma/client';

@Controller(['businesses/me/clients', 'clients'])
export class ClientsController {
  constructor(private readonly clientsService: ClientsService) {}

  private resolveBusinessId(user: JwtPayload, queryBusinessId?: string): string {
    if (user.role === UserRole.SUPERADMIN && queryBusinessId) {
      return queryBusinessId;
    }
    return user.businessId!;
  }

  @Get()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') queryBusinessId?: string,
  ) {
    return this.clientsService.findAll(this.resolveBusinessId(user, queryBusinessId));
  }

  @Get(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') queryBusinessId?: string,
  ) {
    return this.clientsService.findOne(id, this.resolveBusinessId(user, queryBusinessId));
  }

  @Post()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  create(
    @Body() dto: CreateClientDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') queryBusinessId?: string,
  ) {
    return this.clientsService.create(dto, this.resolveBusinessId(user, queryBusinessId));
  }

  @Patch(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateClientDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') queryBusinessId?: string,
  ) {
    return this.clientsService.update(id, dto, this.resolveBusinessId(user, queryBusinessId));
  }

  @Put(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  updatePut(
    @Param('id') id: string,
    @Body() dto: UpdateClientDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') queryBusinessId?: string,
  ) {
    return this.clientsService.update(id, dto, this.resolveBusinessId(user, queryBusinessId));
  }

  @Delete(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  remove(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') queryBusinessId?: string,
  ) {
    return this.clientsService.remove(id, this.resolveBusinessId(user, queryBusinessId));
  }
}
