import { IsDateString, IsOptional, IsString, IsNotEmpty } from 'class-validator';

export class CreateTimeBlockDto {
  @IsDateString()
  startDatetime: string;

  @IsDateString()
  endDatetime: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  reason?: string;
}
