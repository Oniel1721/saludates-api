import { IsOptional, IsString, IsNotEmpty } from 'class-validator';

export class CancelAppointmentDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  reason?: string;
}
