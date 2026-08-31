import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { InviteCodesService } from './invite-codes.service';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { CreateInviteCodeDto } from './dto/create-invite-code.dto';

@Controller(['invite-codes', 'businesses/me/invite-codes'])
export class InviteCodesController {
  constructor(private readonly service: InviteCodesService) {}

  @Get('validate/:code')
  @Public()
  validateCode(@Param('code') code: string) {
    return this.service.validateCode(code);
  }

  @Post()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  create(@Body() dto: CreateInviteCodeDto, @CurrentUser() user: JwtPayload) {
    return this.service.createInviteCode(dto, user.businessId!);
  }

  @Get()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  findAll(@CurrentUser() user: JwtPayload) {
    return this.service.getInviteCodes(user.businessId!);
  }

  @Patch(':id/deactivate')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  deactivate(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.deactivate(
      id,
      user.businessId,
      user.role === UserRole.SUPERADMIN,
    );
  }

  @Put(':id/deactivate')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  deactivatePut(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.deactivate(
      id,
      user.businessId,
      user.role === UserRole.SUPERADMIN,
    );
  }

  @Get(':id/riders')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  getRiders(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.getRiders(
      id,
      user.businessId,
      user.role === UserRole.SUPERADMIN,
    );
  }
}
