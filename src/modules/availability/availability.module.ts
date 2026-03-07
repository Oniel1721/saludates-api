import { Module } from '@nestjs/common';
import { AvailabilityController } from '@/modules/availability/availability.controller';
import { AvailabilityService } from '@/modules/availability/availability.service';

@Module({
  controllers: [AvailabilityController],
  providers: [AvailabilityService],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
