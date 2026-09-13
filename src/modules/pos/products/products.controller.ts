import {
  Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { PosGuard } from "../../../common/guards/pos.guard";
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { JwtPayload } from "../../../common/types/jwt-payload.interface";
import { Roles } from "../../../common/decorators/roles.decorator";
import { UserRole } from "@prisma/client";
import { resolveBusinessId } from "../pos.utils";
import { ProductsService } from "./products.service";
import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";
import { AdjustStockDto } from "./dto/adjust-stock.dto";

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller("pos/products")
export class ProductsController {
  constructor(private readonly service: ProductsService) {}

  @Get()
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
    @Query("search") search?: string,
    @Query("categoryId") categoryId?: string,
    @Query("lowStock") lowStock?: string,
  ) {
    return this.service.findAll(resolveBusinessId(user, qBid), {
      search,
      categoryId,
      lowStock: lowStock === "true",
    });
  }

  @Get("barcode/:barcode")
  findByBarcode(
    @Param("barcode") barcode: string,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.findByBarcode(resolveBusinessId(user, qBid), barcode);
  }

  @Get(":id")
  findOne(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.findOne(id, resolveBusinessId(user, qBid));
  }

  @Post()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  create(
    @Body() dto: CreateProductDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.create(dto, resolveBusinessId(user, qBid));
  }

  @Patch(":id")
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  update(
    @Param("id") id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.update(id, dto, resolveBusinessId(user, qBid));
  }

  @Put(":id")
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  updatePut(
    @Param("id") id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.update(id, dto, resolveBusinessId(user, qBid));
  }

  @Delete(":id")
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  remove(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.remove(id, resolveBusinessId(user, qBid));
  }

  @Post(":id/stock")
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  adjustStock(
    @Param("id") id: string,
    @Body() dto: AdjustStockDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.adjustStock(id, dto, user.sub, resolveBusinessId(user, qBid));
  }

  @Get(":id/movements")
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  getMovements(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.getStockMovements(id, resolveBusinessId(user, qBid));
  }
}
