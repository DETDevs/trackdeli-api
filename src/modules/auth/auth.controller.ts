import { Controller, Get, Post } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly service: AuthService) {}

  @Get('health')
  healthCheck() {
    return { status: 'ok', module: 'auth' };
  }

  @Post('login')
  login() {
    return { message: 'login placeholder' };
  }

  @Post('refresh')
  refresh() {
    return { message: 'refresh placeholder' };
  }
}

