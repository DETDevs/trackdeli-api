import {
  Controller,
  Get,
  HttpStatus,
  Param,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../../common/decorators/public.decorator';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { SkipClientVersionCheck } from '../../client-version/decorators/skip-client-version-check.decorator';
import { ReceiptLinksService } from './receipt-links.service';

@Public()
@SkipClientVersionCheck()
@SkipMembershipCheck()
@Throttle({ default: { limit: 30, ttl: 60000 } })
@Controller('r')
export class PublicReceiptsController {
  constructor(private readonly service: ReceiptLinksService) {}

  /**
   * Página pública liviana para ver el comprobante digital de venta (rate limit 30/min por IP).
   */
  @Get(':token')
  async viewReceiptPage(@Param('token') token: string, @Res() res: any) {
    const data = await this.service.getPublicReceiptData(token);
    const html = this.service.renderReceiptHtml(data);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (data.status === 'NOT_FOUND') {
      return res.status(HttpStatus.NOT_FOUND).send(html);
    }

    if (data.status === 'EXPIRED_OR_REVOKED') {
      return res.status(HttpStatus.GONE).send(html); // HTTP 410
    }

    return res.status(HttpStatus.OK).send(html);
  }

  /**
   * Transmite el archivo PDF del comprobante desde R2 a través de la API (stream).
   */
  @Get(':token/pdf')
  async downloadReceiptPdf(@Param('token') token: string, @Res() res: any) {
    return this.service.streamReceiptPdf(token, res);
  }
}
