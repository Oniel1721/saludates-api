import { Injectable, NotFoundException } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';

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
  constructor(private prisma: PrismaService) {}

  /**
   * Creates a notification. Called internally by the bot and the scheduler.
   * SSE push will be added here when real-time delivery is implemented (T-35).
   */
  create(params: CreateNotificationParams) {
    return this.prisma.notification.create({
      data: {
        clinicId: params.clinicId,
        type: params.type,
        title: params.title,
        body: params.body,
        appointmentId: params.appointmentId,
        conversationId: params.conversationId,
      },
    });
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
