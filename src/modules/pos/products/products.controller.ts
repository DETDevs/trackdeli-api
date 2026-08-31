import {
  Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { PosGuard } from "../../../common/guards/pos.guard";
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { JwtPayload } from "../../../common/types/jwt-payload.interface";
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
  create(
    @Body() dto: CreateProductDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.create(dto, resolveBusinessId(user, qBid));
  }

  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.update(id, dto, resolveBusinessId(user, qBid));
  }

  @Put(":id")
  updatePut(
    @Param("id") id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.update(id, dto, resolveBusinessId(user, qBid));
  }

  @Delete(":id")
  remove(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.remove(id, resolveBusinessId(user, qBid));
  }

  @Post(":id/stock")
  adjustStock(
    @Param("id") id: string,
    @Body() dto: AdjustStockDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.adjustStock(id, dto, user.sub, resolveBusinessId(user, qBid));
  }

  @Get(":id/movements")
  getMovements(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.getStockMovements(id, resolveBusinessId(user, qBid));
  }
}
