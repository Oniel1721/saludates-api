import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtPayload, RequestUser } from '@/modules/auth/auth.types';
import { EnvironmentService } from '@/config/environment.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(env: EnvironmentService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: env.jwtSecret,
    });
  }

  validate(payload: JwtPayload): RequestUser {
    if (!payload.sub || !payload.role) {
      throw new UnauthorizedException();
    }

    return {
      email: payload.sub,
      role: payload.role,
      clinicId: payload.clinicId,
    };
  }
}
