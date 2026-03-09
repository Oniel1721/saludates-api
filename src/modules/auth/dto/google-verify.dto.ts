import { IsString } from 'class-validator';

export class GoogleVerifyDto {
  @IsString()
  idToken: string;
}
