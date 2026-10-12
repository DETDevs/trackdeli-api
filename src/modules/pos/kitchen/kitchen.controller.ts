import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  Headers,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { SkipWebAdminAccess } from '../../../common/decorators/skip-web-admin-access.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { resolveBusinessId } from '../pos.utils';
import { KitchenService } from './kitchen.service';

@SkipMembershipCheck()
@SkipWebAdminAccess()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller('pos/kitchen')
export class KitchenController {
  constructor(private readonly service: KitchenService) {}

  @Get('rounds/pending-print')
  @Roles(UserRole.CAJERO, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  getPendingPrint(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.getPendingPrint(resolveBusinessId(user, qBid));
  }

  @Post('rounds/:id/claim-print')
  @Roles(UserRole.CAJERO, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  @HttpCode(HttpStatus.OK)
  claimPrint(
    @Param('id') id: string,
    @Body('claimedBy') claimedBy: string,
    @Headers('x-device-id') headerDeviceId: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const finalClaimedBy = claimedBy || headerDeviceId || user.sub;
    return this.service.claimPrint(
      resolveBusinessId(user, qBid),
      id,
      finalClaimedBy,
    );
  }

  @Post('rounds/:id/printed')
  @Roles(UserRole.CAJERO, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  @HttpCode(HttpStatus.OK)
  markPrinted(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.markPrinted(resolveBusinessId(user, qBid), id);
  }

  @Post('rounds/:id/print-failed')
  @Roles(UserRole.CAJERO, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  @HttpCode(HttpStatus.OK)
  markPrintFailed(
    @Param('id') id: string,
    @Body('error') error: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.markPrintFailed(
      resolveBusinessId(user, qBid),
      id,
      error,
    );
  }

  @Post('rounds/:id/reprint')
  @Roles(UserRole.CAJERO, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  @HttpCode(HttpStatus.OK)
  reprint(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.reprint(resolveBusinessId(user, qBid), id, user);
  }
}
