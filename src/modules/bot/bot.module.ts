import { Module } from '@nestjs/common';
import { BotService } from '@/modules/bot/bot.service';
import { IntentService } from '@/modules/bot/intent.service';
import { CreateAppointmentFlow } from '@/modules/bot/flows/create-appointment.flow';
import { ConfirmingFlow } from '@/modules/bot/flows/confirming.flow';
import { CancellingFlow } from '@/modules/bot/flows/cancelling.flow';
import { WhatsAppModule } from '@/modules/whatsapp/whatsapp.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { AvailabilityModule } from '@/modules/availability/availability.module';

@Module({
  imports: [WhatsAppModule, NotificationsModule, AvailabilityModule],
  providers: [BotService, IntentService, CreateAppointmentFlow, ConfirmingFlow, CancellingFlow],
  exports: [BotService, ConfirmingFlow],
})
export class BotModule {}
