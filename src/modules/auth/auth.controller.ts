import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
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

  @Post('refresh')
  @Public()
  @UseGuards(JwtRefreshGuard)
  async refresh(@CurrentUser() user: JwtPayload): Promise<TokenResponseDto> {
    // El interceptor del header via guard asume que mandaron su token, en la req hay payload
    // Pero como no guardamos el refresh token en db, simplemente generamos uno nuevo.
    // Usamos dummy refresh token empty para cumplir con la firma o extraemos req.headers.authorization
    return this.authService.refresh(user.sub, '');
  }

  @Get('me')
  async me(@CurrentUser() user: JwtPayload) {
    return user;
  }
}
