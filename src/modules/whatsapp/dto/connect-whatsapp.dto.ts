import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class ConnectWhatsAppDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^\+\d{7,15}$/, { message: 'phone must be a E.164 phone number (e.g. +18091234567)' })
  phone: string;
}
