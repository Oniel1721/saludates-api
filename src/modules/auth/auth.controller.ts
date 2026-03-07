import { Controller, Post, Body, Get, UseGuards } from '@nestjs/common';
import { AuthService } from '@/modules/auth/auth.service';
import { GoogleVerifyDto } from '@/modules/auth/dto/google-verify.dto';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/auth/decorators/current-user.decorator';
import type { RequestUser } from '@/modules/auth/auth.types';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('google/verify')
  verifyGoogle(@Body() body: GoogleVerifyDto) {
    return this.authService.verifyGoogleToken(body.idToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: RequestUser) {
    return user;
  }
}
