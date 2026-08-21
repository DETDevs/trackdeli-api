import { Controller, Get, Post, Param } from '@nestjs/common';
import { RatingsService } from './ratings.service';
import { Public } from '../../common/decorators/public.decorator';

@Controller('ratings')
export class RatingsController {
  constructor(private readonly service: RatingsService) {}

  @Get('health')
  @Public()
  healthCheck() {
    return { status: 'ok', module: 'ratings' };
  }

  @Post('track/:token/rating')
  @Public()
  createRating(@Param('token') token: string) {
    return { message: 'rating placeholder for ' + token };
  }
}

