import { Module } from '@nestjs/common';
import { WhatsAppService } from '@/modules/whatsapp/whatsapp.service';
import { WhatsAppController } from '@/modules/whatsapp/whatsapp.controller';
import { WhatsAppWebhookController } from '@/modules/whatsapp/whatsapp-webhook.controller';

@Module({
  controllers: [WhatsAppController, WhatsAppWebhookController],
  providers: [WhatsAppService],
  exports: [WhatsAppService], // Used by appointments, scheduler, and bot modules
})
export class WhatsAppModule {}
