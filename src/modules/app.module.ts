import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { EnvironmentModule } from '@/config/environment.module';
import { ClinicsModule } from '@/modules/clinics/clinics.module';
import { ServicesModule } from '@/modules/services/services.module';
import { AvailabilityModule } from '@/modules/availability/availability.module';
import { AppointmentsModule } from '@/modules/appointments/appointments.module';
import { PatientsModule } from '@/modules/patients/patients.module';
import { ConversationsModule } from '@/modules/conversations/conversations.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { WhatsAppModule } from '@/modules/whatsapp/whatsapp.module';
import { BotModule } from '@/modules/bot/bot.module';
import { SchedulerModule } from '@/modules/scheduler/scheduler.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    EnvironmentModule,
    PrismaModule,
    AuthModule,
    ClinicsModule,
    ServicesModule,
    AvailabilityModule,
    AppointmentsModule,
    PatientsModule,
    ConversationsModule,
    NotificationsModule,
    WhatsAppModule,
    BotModule,
    SchedulerModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
