import { Module } from '@nestjs/common';
import { ClinicsController } from '@/modules/clinics/clinics.controller';
import { ClinicsService } from '@/modules/clinics/clinics.service';

@Module({
  controllers: [ClinicsController],
  providers: [ClinicsService],
  exports: [ClinicsService],
})
export class ClinicsModule {}
