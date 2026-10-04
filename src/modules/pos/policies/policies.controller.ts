import { Body, Controller, Get, Patch, Query, UseGuards } from '@nestjs/common';
import { PoliciesService } from './policies.service';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { resolveBusinessId } from '../pos.utils';
import { UpdatePosPoliciesDto } from './dto/update-policies.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller('pos/policies')
export class PoliciesController {
  constructor(private readonly service: PoliciesService) {}

  @Get()
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN, UserRole.WAITER) // Todos necesitan leer las políticas
  getPolicies(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.get(resolveBusinessId(user, qBid));
  }

  @Patch()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  updatePolicies(
    @Body() dto: UpdatePosPoliciesDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const dataToUpdate: any = { ...dto };
    if (dto.cashDifferenceTolerance !== undefined) {
      dataToUpdate.cashDifferenceTolerance = dto.cashDifferenceTolerance;
    }
    
    return this.service.update(
      resolveBusinessId(user, qBid),
      dataToUpdate,
      user.sub,
      user.role,
    );
  }
}
