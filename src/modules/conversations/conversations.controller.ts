import { Controller, Get, Post, Param, Query, UseGuards } from '@nestjs/common';
import { ConversationFlow } from '@prisma/client';
import { ConversationsService } from '@/modules/conversations/conversations.service';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { ClinicGuard } from '@/modules/auth/guards/clinic.guard';

@Controller('clinics/:clinicId/conversations')
@UseGuards(JwtAuthGuard, ClinicGuard)
export class ConversationsController {
  constructor(private conversations: ConversationsService) {}

  // Inbox — ?flow=ESCALATED to filter only escalated (T-28)
  @Get()
  findAll(
    @Param('clinicId') clinicId: string,
    @Query('flow') flow?: ConversationFlow,
  ) {
    return this.conversations.findAll(clinicId, flow);
  }

  // Conversation detail with full message history (T-28)
  @Get(':conversationId')
  findOne(
    @Param('clinicId') clinicId: string,
    @Param('conversationId') conversationId: string,
  ) {
    return this.conversations.findOne(clinicId, conversationId);
  }

  // Resolve escalation — bot resumes (T-28)
  @Post(':conversationId/resolve')
  resolve(
    @Param('clinicId') clinicId: string,
    @Param('conversationId') conversationId: string,
  ) {
    return this.conversations.resolve(clinicId, conversationId);
  }
}
