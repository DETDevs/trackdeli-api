import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { resolveBusinessId } from '../pos.utils';
import { ProductPresentationsService } from './product-presentations.service';
import { CreatePresentationDto } from './dto/create-presentation.dto';
import { UpdatePresentationDto } from './dto/update-presentation.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller('pos/products/:id/presentations')
export class ProductPresentationsController {
  constructor(private readonly service: ProductPresentationsService) {}

  @Get()
  @Roles(
    UserRole.ENCARGADO,
    UserRole.CAJERO,
    UserRole.SUPERADMIN,
    UserRole.WAITER,
    UserRole.VENDEDOR,
  )
  findByProduct(
    @Param('id') productId: string,
    @CurrentUser() user: JwtPayload,
    @Query('includeInactive') includeInactive?: string,
    @Query('businessId') qBid?: string,
  ) {
    const wantInactive = includeInactive === 'true' || includeInactive === '1';
    return this.service.findByProduct(
      resolveBusinessId(user, qBid),
      productId,
      wantInactive,
      user.role,
    );
  }

  @Post()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  create(
    @Param('id') productId: string,
    @Body() dto: CreatePresentationDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.create(resolveBusinessId(user, qBid), productId, dto);
  }

  @Patch(':presentationId')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  update(
    @Param('id') productId: string,
    @Param('presentationId') presentationId: string,
    @Body() dto: UpdatePresentationDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.update(
      resolveBusinessId(user, qBid),
      productId,
      presentationId,
      dto,
    );
  }

  @Delete(':presentationId')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  remove(
    @Param('id') productId: string,
    @Param('presentationId') presentationId: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.remove(
      resolveBusinessId(user, qBid),
      productId,
      presentationId,
    );
  }
}
