import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { BusinessProductType, UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SkipMembershipCheck } from '../../common/decorators/skip-membership.decorator';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { BusinessProductsService } from './business-products.service';
import { ActivateProductDto } from './dto/activate-product.dto';
import { DeactivateProductDto } from './dto/deactivate-product.dto';
import { CancelRenewalDto } from './dto/cancel-renewal.dto';
import { DeactivateNowProductDto } from './dto/deactivate-now-product.dto';

@Controller(['businesses/:id/products', 'businesses/me/products'])
@UseGuards(JwtAuthGuard, RolesGuard)
export class BusinessProductsController {
  constructor(private readonly service: BusinessProductsService) {}

  @Get()
  @SkipMembershipCheck()
  @Roles(UserRole.SUPERADMIN, UserRole.ENCARGADO, UserRole.CAJERO)
  getProducts(
    @Param('id') businessId: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    const targetBusinessId =
      !businessId || businessId === 'me' ? user.businessId : businessId;

    if (!targetBusinessId) {
      throw new ForbiddenException('Sin negocio asociado');
    }

    if (
      user.role !== UserRole.SUPERADMIN &&
      user.businessId !== targetBusinessId
    ) {
      throw new ForbiddenException(
        'No tienes permiso para ver los productos de este negocio',
      );
    }

    return this.service.getProducts(targetBusinessId);
  }

  @Post(':productType/activate')
  @Roles(UserRole.SUPERADMIN)
  @HttpCode(HttpStatus.OK)
  activateProduct(
    @Param('id') businessId: string,
    @Param('productType') productTypeStr: string,
    @Body() dto: ActivateProductDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const productType = productTypeStr.toUpperCase() as BusinessProductType;
    return this.service.activateProduct(businessId, productType, dto, user.sub);
  }

  @Post(':productType/deactivate')
  @Roles(UserRole.SUPERADMIN)
  @HttpCode(HttpStatus.OK)
  deactivateProduct(
    @Param('id') businessId: string,
    @Param('productType') productTypeStr: string,
    @Query('force') forceQuery: string,
    @Body() dto: DeactivateProductDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const productType = productTypeStr.toUpperCase() as BusinessProductType;
    const force = forceQuery === 'true';
    return this.service.deactivateProduct(businessId, productType, dto, force, user.sub);
  }

  @Post(':productType/cancel-renewal')
  @Roles(UserRole.SUPERADMIN)
  @HttpCode(HttpStatus.OK)
  cancelRenewal(
    @Param('id') businessId: string,
    @Param('productType') productTypeStr: string,
    @Body() dto: CancelRenewalDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const productType = productTypeStr.toUpperCase() as BusinessProductType;
    return this.service.cancelRenewal(businessId, productType, dto, user.sub);
  }

  @Post(':productType/deactivate-now')
  @Roles(UserRole.SUPERADMIN)
  @HttpCode(HttpStatus.OK)
  deactivateNow(
    @Param('id') businessId: string,
    @Param('productType') productTypeStr: string,
    @Body() dto: DeactivateNowProductDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const productType = productTypeStr.toUpperCase() as BusinessProductType;
    return this.service.deactivateNow(businessId, productType, dto, user.sub);
  }

  @Get(':productType/audit-log')
  @Roles(UserRole.SUPERADMIN)
  getAuditLog(
    @Param('id') businessId: string,
    @Param('productType') productTypeStr: string,
  ) {
    const productType = productTypeStr.toUpperCase() as BusinessProductType;
    return this.service.getAuditLog(businessId, productType);
  }
}

