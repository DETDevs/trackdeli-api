import { Controller, Get, Post, Param } from '@nestjs/common';
import { RatingsService } from './ratings.service';

@Controller('ratings')
export class RatingsController {
  constructor(private readonly service: RatingsService) {}

  @Get('health')
  healthCheck() {
    return { status: 'ok', module: 'ratings' };
  }

  @Post('track/:token/rating')
  createRating(@Param('token') token: string) {
    return { message: 'rating placeholder for ' + token };
  }
}

