import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConversationFlow, Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';

@Injectable()
export class ConversationsService {
  constructor(private prisma: PrismaService) {}

  /**
   * List conversations for the clinic inbox (T-28).
   * Optionally filter by flow (e.g. ESCALATED to show only escalated ones).
   * Returns conversations ordered by most recently updated first,
   * with patient info and last message for preview.
   */
  findAll(clinicId: string, flow?: ConversationFlow) {
    return this.prisma.conversation.findMany({
      where: {
        clinicId,
        ...(flow ? { flow } : {}),
      },
      include: {
        patient: true,
        messages: {
          orderBy: { sentAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /** Full conversation with all messages (T-28). */
  async findOne(clinicId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, clinicId },
      include: {
        patient: true,
        appointment: { include: { service: true, patient: true } },
        messages: { orderBy: { sentAt: 'asc' } },
      },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    return conversation;
  }

  /**
   * Resolve an escalated conversation (T-28).
   * Sets flow back to OUT_OF_FLOW so the bot resumes handling it.
   */
  async resolve(clinicId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, clinicId },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');

    if (conversation.flow !== 'ESCALATED') {
      throw new BadRequestException('Conversation is not escalated');
    }

    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: { flow: 'OUT_OF_FLOW', flowState: Prisma.JsonNull },
      include: { patient: true },
    });
  }
}
