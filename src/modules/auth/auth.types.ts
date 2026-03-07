export type UserRole = 'CLINIC_USER' | 'SUPERADMIN';

export interface JwtPayload {
  sub: string;       // email
  role: UserRole;
  clinicId: string | null; // null for superadmin
}

export interface RequestUser {
  email: string;
  role: UserRole;
  clinicId: string | null;
}
