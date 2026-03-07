import { Module } from '@nestjs/common';
import { PatientsController } from '@/modules/patients/patients.controller';
import { PatientsService } from '@/modules/patients/patients.service';

@Module({
  controllers: [PatientsController],
  providers: [PatientsService],
  exports: [PatientsService],
})
export class PatientsModule {}
