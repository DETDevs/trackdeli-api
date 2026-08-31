import {
  Controller,
  Get,
  Query,
} from '@nestjs/common';
import { CommissionsService } from './commissions.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { UserRole } from '@prisma/client';

@Controller()
export class CommissionsController {
  constructor(private readonly commissionsService: CommissionsService) {}

  private resolveBusinessId(user: JwtPayload, queryBusinessId?: string): string {
    if (user.role === UserRole.SUPERADMIN && queryBusinessId) {
      return queryBusinessId;
    }
    return user.businessId!;
  }

  @Get('commissions')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  getCommissions(
    @CurrentUser() user: JwtPayload,
    @Query('month') month?: string,
    @Query('year') year?: string,
    @Query('businessId') queryBusinessId?: string,
  ) {
    return this.commissionsService.getCommissions(
      this.resolveBusinessId(user, queryBusinessId),
      month ? parseInt(month) : undefined,
      year ? parseInt(year) : undefined,
    );
  }

  @Get('commissions/summary')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  getSummary(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') queryBusinessId?: string,
  ) {
    return this.commissionsService.getSummary(this.resolveBusinessId(user, queryBusinessId));
  }

  @Get('statements')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  getStatements(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') queryBusinessId?: string,
  ) {
    return this.commissionsService.getStatements(this.resolveBusinessId(user, queryBusinessId));
  }
}
