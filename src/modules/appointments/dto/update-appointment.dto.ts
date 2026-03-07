import { IsString, IsNotEmpty, IsDateString, IsOptional, IsInt, IsPositive } from 'class-validator';

export class UpdateAppointmentDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  patientName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  serviceId?: string;

  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  price?: number;
}
