import { Body, Controller, Post, Query, UseGuards } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { resolveBusinessId } from '../pos.utils';
import { CreateApprovalDto } from './dto/create-approval.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Roles(UserRole.CAJERO, UserRole.ENCARGADO, UserRole.SUPERADMIN)
@Controller('pos/approvals')
export class ApprovalsController {
  constructor(private readonly service: ApprovalsService) {}

  @Post()
  async createToken(
    @Body() dto: CreateApprovalDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const token = await this.service.createToken(
      resolveBusinessId(user, qBid),
      dto,
      user.sub,
      user.role
    );
    return { token };
  }
}
