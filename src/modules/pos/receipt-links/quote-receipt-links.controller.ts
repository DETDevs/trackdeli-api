import {
  Controller,
  Param,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { resolveBusinessId } from '../pos.utils';
import { ReceiptLinksService } from './receipt-links.service';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, RolesGuard, PosGuard)
@Roles(UserRole.SUPERADMIN, UserRole.ENCARGADO, UserRole.CAJERO, UserRole.VENDEDOR)
@Controller('pos/quotes')
export class QuoteReceiptLinksController {
  constructor(private readonly service: ReceiptLinksService) {}

  /**
   * Sube la proforma en PDF generada por desktop/web a R2 y devuelve enlace público /proforma/:token
   */
  @Post(':id/receipt-link')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 500 * 1024 } }))
  async uploadQuoteReceiptLink(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.uploadQuoteReceiptPdf(id, businessId, user.sub, user.role, file);
  }
}

