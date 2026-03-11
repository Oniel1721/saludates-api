import { Module } from '@nestjs/common';
import { BotService } from '@/modules/bot/bot.service';
import { AgentService } from '@/modules/bot/agent.service';
import { BotToolsService } from '@/modules/bot/bot-tools.service';
import { WhatsAppModule } from '@/modules/whatsapp/whatsapp.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { AvailabilityModule } from '@/modules/availability/availability.module';

@Module({
  imports: [WhatsAppModule, NotificationsModule, AvailabilityModule],
  providers: [BotService, AgentService, BotToolsService],
  exports: [BotService],
})
export class BotModule {}
