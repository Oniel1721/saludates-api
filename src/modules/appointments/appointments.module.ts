import { Module } from '@nestjs/common';
import { AppointmentsController } from '@/modules/appointments/appointments.controller';
import { AppointmentsService } from '@/modules/appointments/appointments.service';
import { AvailabilityModule } from '@/modules/availability/availability.module';
import { WhatsAppModule } from '@/modules/whatsapp/whatsapp.module';

@Module({
  imports: [AvailabilityModule, WhatsAppModule],
  controllers: [AppointmentsController],
  providers: [AppointmentsService],
  exports: [AppointmentsService],
})
export class AppointmentsModule {}
