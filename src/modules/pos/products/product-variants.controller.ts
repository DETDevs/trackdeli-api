import {
  Body,
  Controller,
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
import { ProductVariantsService } from './product-variants.service';
import { GenerateVariantsDto } from './dto/generate-variants.dto';
import { UpdateVariantDto } from './dto/update-variant.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller('pos/products/:id/variants')
export class ProductVariantsController {
  constructor(private readonly service: ProductVariantsService) {}

  @Post('generate')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  generate(
    @Param('id') productId: string,
    @Body() dto: GenerateVariantsDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.generate(
      resolveBusinessId(user, qBid),
      productId,
      dto,
      user.role,
    );
  }

  @Get()
  @Roles(
    UserRole.ENCARGADO,
    UserRole.CAJERO,
    UserRole.SUPERADMIN,
    UserRole.WAITER,
    UserRole.VENDEDOR,
  )
  listByParent(
    @Param('id') productId: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.listByParent(
      resolveBusinessId(user, qBid),
      productId,
      user.role,
    );
  }

  @Patch(':variantId')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  updateVariant(
    @Param('id') productId: string,
    @Param('variantId') variantId: string,
    @Body() dto: UpdateVariantDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.updateVariant(
      resolveBusinessId(user, qBid),
      productId,
      variantId,
      dto,
      user.role,
    );
  }
}
