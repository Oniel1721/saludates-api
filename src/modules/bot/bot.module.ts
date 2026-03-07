import { Module } from '@nestjs/common';
import { BotService } from '@/modules/bot/bot.service';
import { IntentService } from '@/modules/bot/intent.service';
import { WhatsAppModule } from '@/modules/whatsapp/whatsapp.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';

@Module({
  imports: [WhatsAppModule, NotificationsModule],
  providers: [BotService, IntentService],
  exports: [BotService],
})
export class BotModule {}
