import { IsString, IsNotEmpty, IsDateString, IsOptional, IsInt, IsPositive, Matches } from 'class-validator';

export class CreateAppointmentDto {
  @IsString()
  @IsNotEmpty()
  patientName: string;

  @IsString()
  @Matches(/^\d{7,15}$/, { message: 'patientPhone must be a numeric string (7–15 digits)' })
  patientPhone: string;

  @IsString()
  @IsNotEmpty()
  serviceId: string;

  @IsDateString()
  startsAt: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  price?: number;
}
