import { IsString, IsNotEmpty, IsArray, IsEmail, ArrayNotEmpty } from 'class-validator';

export class CreateClinicDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  address: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsEmail({}, { each: true })
  authorizedEmails: string[];
}
