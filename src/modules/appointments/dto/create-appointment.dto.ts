import { IsString, IsNotEmpty, IsDateString, IsOptional, IsInt, IsPositive, Matches } from 'class-validator';

export class CreateAppointmentDto {
  @IsString()
  @IsNotEmpty()
  patientName: string;

  @IsString()
  @Matches(/^\+\d{7,15}$/, { message: 'patientPhone must be a E.164 phone number (e.g. +18091234567)' })
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
