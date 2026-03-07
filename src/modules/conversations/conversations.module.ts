import { Module } from '@nestjs/common';
import { ConversationsController } from '@/modules/conversations/conversations.controller';
import { ConversationsService } from '@/modules/conversations/conversations.service';

@Module({
  controllers: [ConversationsController],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
