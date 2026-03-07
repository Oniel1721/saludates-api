import { IsArray, ArrayNotEmpty, IsEmail } from 'class-validator';

export class UpdateClinicEmailsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsEmail({}, { each: true })
  authorizedEmails: string[];
}
