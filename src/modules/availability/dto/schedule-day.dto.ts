import { IsInt, IsBoolean, IsString, Matches, Min, Max, ValidateIf } from 'class-validator';

export class ScheduleDayDto {
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek: number;

  @IsBoolean()
  isActive: boolean;

  @ValidateIf((o) => o.isActive)
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'startTime must be HH:MM format' })
  startTime: string;

  @ValidateIf((o) => o.isActive)
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'endTime must be HH:MM format' })
  endTime: string;
}
