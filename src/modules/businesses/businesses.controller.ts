import { Body, Controller, Get, Patch } from '@nestjs/common';
import { BusinessesService } from './businesses.service';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { UpdateBusinessDto } from './dto/update-business.dto';

@Controller('businesses')
export class BusinessesController {
  constructor(private readonly service: BusinessesService) {}

  @Get('me')
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

  @Get('health')
  @Public()
  healthCheck() {
    return { status: 'ok', module: 'businesses' };
  }
}

