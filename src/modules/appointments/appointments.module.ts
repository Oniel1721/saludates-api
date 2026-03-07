import { Module } from '@nestjs/common';
import { AppointmentsController } from '@/modules/appointments/appointments.controller';
import { AppointmentsService } from '@/modules/appointments/appointments.service';
import { AvailabilityModule } from '@/modules/availability/availability.module';

@Module({
  imports: [AvailabilityModule],
  controllers: [AppointmentsController],
  providers: [AppointmentsService],
  exports: [AppointmentsService],
})
export class AppointmentsModule {}
