import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { RequestUser } from '@/modules/auth/auth.types';

// Verifies that the authenticated user belongs to the clinic in the route param.
// Superadmins bypass this check and can access any clinic.
@Injectable()
export class ClinicGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user: RequestUser = request.user;
    const clinicId: string = request.params.clinicId;

    if (user?.role === 'SUPERADMIN') return true;

    if (user?.clinicId !== clinicId) {
      throw new ForbiddenException('Access to this clinic is not allowed');
    }

    return true;
  }
}
