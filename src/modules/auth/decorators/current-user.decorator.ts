import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { RequestUser } from '@/modules/auth/auth.types';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestUser => {
    return ctx.switchToHttp().getRequest().user;
  },
);
