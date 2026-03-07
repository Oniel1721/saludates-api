import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class UpdateClinicDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  address?: string;
}
