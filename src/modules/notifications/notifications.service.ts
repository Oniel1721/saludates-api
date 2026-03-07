import { Injectable, NotFoundException } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { SseService } from '@/modules/sse/sse.service';

export interface CreateNotificationParams {
  clinicId: string;
  type: NotificationType;
  title: string;
  body: string;
  appointmentId?: string;
  conversationId?: string;
}

@Injectable()
export class NotificationsService {
  constructor(
    private prisma: PrismaService,
    private sse: SseService,
  ) {}

  /**
   * Creates a notification and pushes it in real-time to connected SSE clients.
   * Called internally by the bot and the scheduler.
   */
  async create(params: CreateNotificationParams) {
    const notification = await this.prisma.notification.create({
      data: {
        clinicId: params.clinicId,
        type: params.type,
        title: params.title,
        body: params.body,
        appointmentId: params.appointmentId,
        conversationId: params.conversationId,
      },
    });

    this.sse.emit(params.clinicId, { type: 'notification', notification });

    return notification;
  }

  /** List notifications for the clinic. Pass unreadOnly=true for the badge count. */
  findAll(clinicId: string, unreadOnly = false) {
    return this.prisma.notification.findMany({
      where: {
        clinicId,
        ...(unreadOnly ? { readAt: null } : {}),
      },
      include: {
        appointment: { include: { patient: true, service: true } },
        conversation: { include: { patient: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async markRead(clinicId: string, notificationId: string) {
    const notification = await this.prisma.notification.findFirst({
      where: { id: notificationId, clinicId },
    });
    if (!notification) throw new NotFoundException('Notification not found');

    if (notification.readAt) return notification; // already read, no-op

    return this.prisma.notification.update({
      where: { id: notificationId },
      data: { readAt: new Date() },
    });
  }

  markAllRead(clinicId: string) {
    return this.prisma.notification.updateMany({
      where: { clinicId, readAt: null },
      data: { readAt: new Date() },
    });
  }
}
