import {
  Body,
  Controller,
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
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { BusinessProductsService } from './business-products.service';
import { ActivateProductDto } from './dto/activate-product.dto';
import { DeactivateProductDto } from './dto/deactivate-product.dto';

@Controller('businesses/:id/products')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPERADMIN)
export class BusinessProductsController {
  constructor(private readonly service: BusinessProductsService) {}

  /**
   * GET /businesses/:id/products
   * Devuelve el estado actual de AMBOS productos (DELIVERY y POS) para el negocio.
   */
  @Get()
  getProducts(@Param('id') businessId: string) {
    return this.service.getProducts(businessId);
  }

  /**
   * POST /businesses/:id/products/:productType/activate
   * Activa un producto (o actualiza su configuración de forma idempotente si ya estaba activo).
   */
  @Post(':productType/activate')
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

  /**
   * POST /businesses/:id/products/:productType/deactivate
   * Desactiva un producto, bloqueando si hay operaciones activas a menos que ?force=true esté presente.
   */
  @Post(':productType/deactivate')
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

  /**
   * GET /businesses/:id/products/:productType/audit-log
   * Historial completo de cambios para ese producto de ese negocio, orden descendente por fecha.
   */
  @Get(':productType/audit-log')
  getAuditLog(
    @Param('id') businessId: string,
    @Param('productType') productTypeStr: string,
  ) {
    const productType = productTypeStr.toUpperCase() as BusinessProductType;
    return this.service.getAuditLog(businessId, productType);
  }
}
