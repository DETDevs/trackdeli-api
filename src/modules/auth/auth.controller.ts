import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterRiderDto } from './dto/register-rider.dto';
import { TokenResponseDto } from './dto/token-response.dto';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtRefreshGuard } from '../../common/guards/jwt-refresh.guard';
import { JwtPayload } from '../../common/types/jwt-payload.interface';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('health')
  @Public()
  healthCheck() {
    return { status: 'ok', module: 'auth' };
  }

  @Post('login')
  @Public()
  async login(@Body() dto: LoginDto): Promise<TokenResponseDto> {
    return this.authService.login(dto);
  }

  @Post('register/rider')
  @Public()
  async registerRider(@Body() dto: RegisterRiderDto): Promise<TokenResponseDto> {
    return this.authService.registerRider(dto);
  }

  @Post('refresh')
  @Public()
  async refresh(@Body() body: { refreshToken: string }): Promise<TokenResponseDto> {
    return this.authService.refresh(body.refreshToken);
  }

  @Get('me')
  async me(@CurrentUser() user: JwtPayload) {
    return this.authService.getProfile(user.sub);
  }
}
