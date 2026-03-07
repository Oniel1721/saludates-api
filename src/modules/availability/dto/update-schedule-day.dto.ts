import { IsBoolean, IsString, IsOptional, Matches, ValidateIf } from 'class-validator';

export class UpdateScheduleDayDto {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ValidateIf((o) => o.isActive !== false)
  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'startTime must be HH:MM format' })
  startTime?: string;

  @ValidateIf((o) => o.isActive !== false)
  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'endTime must be HH:MM format' })
  endTime?: string;
}
