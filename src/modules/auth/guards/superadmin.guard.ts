import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { RequestUser } from '@/modules/auth/auth.types';

@Injectable()
export class SuperadminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user: RequestUser = context.switchToHttp().getRequest().user;

    if (user?.role !== 'SUPERADMIN') {
      throw new ForbiddenException('Superadmin access required');
    }

    return true;
  }
}
