import { IsIn } from 'class-validator';

export class MarkResultDto {
  @IsIn(['COMPLETED', 'NO_SHOW'])
  status: 'COMPLETED' | 'NO_SHOW';
}
