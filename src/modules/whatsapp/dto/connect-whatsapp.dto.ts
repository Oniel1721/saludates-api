import { IsNotEmpty, IsString } from 'class-validator';

export class ConnectWhatsAppDto {
  @IsString()
  @IsNotEmpty()
  phone: string; // e.g. "18091234567" — raw number, no "+"
}
