import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OAuth2Client } from 'google-auth-library';
import { PrismaService } from '@/prisma/prisma.service';
import { JwtPayload, RequestUser } from '@/modules/auth/auth.types';

@Injectable()
export class AuthService {
  private googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  async verifyGoogleToken(idToken: string): Promise<{ accessToken: string; user: RequestUser }> {
    // 1. Verify the id_token with Google
    const ticket = await this.googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    }).catch(() => {
      throw new UnauthorizedException('Invalid Google token');
    });

    const email = ticket.getPayload()?.email;
    if (!email) throw new UnauthorizedException('Could not retrieve email from Google token');

    // 2. Check if superadmin
    const superadminEmails = (process.env.SUPERADMIN_EMAILS ?? '').split(',').map((e) => e.trim());
    if (superadminEmails.includes(email)) {
      return this.issueToken({ email, role: 'SUPERADMIN', clinicId: null });
    }

    // 3. Check if authorized in any clinic
    const clinic = await this.prisma.clinic.findFirst({
      where: { authorizedEmails: { has: email } },
      select: { id: true },
    });

    if (!clinic) {
      throw new UnauthorizedException('This email is not authorized to access any clinic');
    }

    return this.issueToken({ email, role: 'CLINIC_USER', clinicId: clinic.id });
  }

  private issueToken(user: RequestUser): { accessToken: string; user: RequestUser } {
    const payload: JwtPayload = {
      sub: user.email,
      role: user.role,
      clinicId: user.clinicId,
    };

    return {
      accessToken: this.jwt.sign(payload),
      user,
    };
  }
}
