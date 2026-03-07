import { IsString, IsNotEmpty } from 'class-validator';

export class UpdatePatientDto {
  @IsString()
  @IsNotEmpty()
  name: string;
}
