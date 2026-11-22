import {
  BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UploadedFiles, UseGuards, UseInterceptors,
} from "@nestjs/common";
import { AnyFilesInterceptor } from "@nestjs/platform-express";
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
import { SetRecipeComponentsDto } from "./dto/set-recipe-components.dto";
import { BulkUpdateProductsDto } from "./dto/bulk-update-products.dto";
import { UploadService } from "../../upload/upload.service";

const ALLOWED_PRODUCT_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);
const MAX_PRODUCT_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller("pos/products")
export class ProductsController {
  constructor(
    private readonly service: ProductsService,
    private readonly uploadService: UploadService,
  ) {}

  @Post("upload-image")
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  @UseInterceptors(
    AnyFilesInterceptor({
      limits: {
        fileSize: MAX_PRODUCT_IMAGE_SIZE_BYTES + 1024 * 1024, // Validamos tamaño exacto en el handler para dar mensaje 400 claro en español
      },
    }),
  )
  async uploadImage(
    @UploadedFiles() files: Array<Express.Multer.File>,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    const file = files && files.length > 0 ? files[0] : null;
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'IMAGE_FILE_REQUIRED',
        message: 'Debés adjuntar una imagen para el producto.',
      });
    }

    const mime = (file.mimetype || '').toLowerCase().trim();
    if (!ALLOWED_PRODUCT_IMAGE_MIME_TYPES.has(mime)) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'INVALID_IMAGE_TYPE',
        message: 'Formato de archivo no válido. Solo se permiten imágenes JPG, PNG o WebP.',
      });
    }

    if (file.size > MAX_PRODUCT_IMAGE_SIZE_BYTES || file.buffer.length > MAX_PRODUCT_IMAGE_SIZE_BYTES) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'IMAGE_TOO_LARGE',
        message: 'La imagen supera el tamaño máximo permitido de 5 MB.',
      });
    }

    const businessId = resolveBusinessId(user, qBid);
    const imageUrl = await this.uploadService.uploadPhoto(
      file,
      `businesses/${businessId}/products`,
    );

    return { imageUrl };
  }

  @Get()
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN, UserRole.WAITER, UserRole.VENDEDOR)
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
    @Query("search") search?: string,
    @Query("categoryId") categoryId?: string,
    @Query("lowStock") lowStock?: string,
    @Query("taxable") taxable?: string,
    @Query("type") type?: string,
    @Query("isActive") isActive?: string,
    @Query("expiry") expiry?: string,
    @Query("expiryMonth") expiryMonth?: string,
    @Query("sort") sort?: string,
    @Query("groupVariants") groupVariants?: string,
  ) {
    return this.service.findAll(
      resolveBusinessId(user, qBid),
      {
        search,
        categoryId,
        lowStock: lowStock === "true",
        taxable: taxable !== undefined ? (taxable === "true" || taxable === "1") : undefined,
        type,
        isActive: isActive !== undefined ? (isActive === "true" || isActive === "1") : undefined,
        expiry,
        expiryMonth,
        sort,
        groupVariants: groupVariants === "true" || groupVariants === "1",
      },
      user.role,
    );
  }

  @Get("barcode/:barcode")
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN, UserRole.VENDEDOR)
  findByBarcode(
    @Param("barcode") barcode: string,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.findByBarcode(resolveBusinessId(user, qBid), barcode, user.role);
  }

  @Get(":id")
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN, UserRole.VENDEDOR)
  findOne(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.findOne(id, resolveBusinessId(user, qBid), user.role);
  }

  @Post()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  create(
    @Body() dto: CreateProductDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.create(dto, resolveBusinessId(user, qBid), user?.sub);
  }

  @Patch("bulk")
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  bulkUpdate(
    @Body() dto: BulkUpdateProductsDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.bulkUpdate(resolveBusinessId(user, qBid), dto, user);
  }

  @Patch(":id")
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  update(
    @Param("id") id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.update(id, dto, resolveBusinessId(user, qBid), user?.sub);
  }

  @Put(":id")
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  updatePut(
    @Param("id") id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.update(id, dto, resolveBusinessId(user, qBid), user?.sub);
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

  @Get(":id/components")
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  getComponents(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.getRecipeComponents(id, resolveBusinessId(user, qBid));
  }

  @Put(":id/components")
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  setComponents(
    @Param("id") id: string,
    @Body() dto: SetRecipeComponentsDto,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
  ) {
    return this.service.setRecipeComponents(id, dto, resolveBusinessId(user, qBid), user);
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

  @Get(":id/stock-movements")
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  getStockMovements(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
    @Query("type") type?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.service.getStockMovements(id, resolveBusinessId(user, qBid), {
      type,
      from,
      to,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get(":id/movements")
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  getMovements(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Query("businessId") qBid?: string,
    @Query("type") type?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.service.getStockMovements(id, resolveBusinessId(user, qBid), {
      type,
      from,
      to,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}
