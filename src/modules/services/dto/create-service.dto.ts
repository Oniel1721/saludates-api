import { IsString, IsNotEmpty, IsInt, IsPositive, IsOptional, Min } from 'class-validator';

export class CreateServiceDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsInt()
  @IsPositive()
  price: number;

  @IsInt()
  @Min(5)
  durationMinutes: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  prerequisites?: string;
}
