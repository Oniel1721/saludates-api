import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationType } from '@prisma/client';
import { addHours } from 'date-fns';
import { PrismaService } from '@/prisma/prisma.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { ConfirmingFlow } from '@/modules/bot/flows/confirming.flow';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private confirmingFlow: ConfirmingFlow,
  ) {}

  /**
   * Every 5 minutes: send 24h reminder (MSG-04) to PENDING appointments
   * entering the 24h window that haven't received a reminder yet.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async sendReminders(): Promise<void> {
    const now = new Date();
    const in24h = addHours(now, 24);

    const appointments = await this.prisma.appointment.findMany({
      where: {
        status: 'PENDING',
        reminderSentAt: null,
        startsAt: { gt: now, lte: in24h },
      },
      select: { id: true, clinicId: true },
    });

    if (appointments.length === 0) return;
    this.logger.log(`Sending 24h reminders for ${appointments.length} appointment(s)`);

    for (const appt of appointments) {
      try {
        await this.confirmingFlow.sendReminder(appt.clinicId, appt.id);
      } catch (err) {
        this.logger.error(`Failed to send reminder for appointment ${appt.id}: ${err}`);
      }
    }
  }

  /**
   * Every 5 minutes: notify secretary of PENDING appointments
   * within 2h that the patient hasn't confirmed.
   * De-duplicates by checking if an UNCONFIRMED_2H notification already exists.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async notifyUnconfirmed(): Promise<void> {
    const now = new Date();
    const in2h = addHours(now, 2);

    const appointments = await this.prisma.appointment.findMany({
      where: {
        status: 'PENDING',
        startsAt: { gt: now, lte: in2h },
      },
      include: {
        patient: { select: { name: true } },
        service: { select: { name: true } },
      },
    });

    if (appointments.length === 0) return;

    // Find which ones already have an UNCONFIRMED_2H notification
    const appointmentIds = appointments.map((a) => a.id);
    const existing = await this.prisma.notification.findMany({
      where: {
        type: NotificationType.UNCONFIRMED_2H,
        appointmentId: { in: appointmentIds },
      },
      select: { appointmentId: true },
    });
    const alreadyNotified = new Set(existing.map((n) => n.appointmentId));

    const toNotify = appointments.filter((a) => !alreadyNotified.has(a.id));
    if (toNotify.length === 0) return;

    this.logger.log(`Creating UNCONFIRMED_2H notifications for ${toNotify.length} appointment(s)`);

    for (const appt of toNotify) {
      try {
        await this.notifications.create({
          clinicId: appt.clinicId,
          type: NotificationType.UNCONFIRMED_2H,
          title: `Sin confirmar: ${appt.patient.name}`,
          body: `La cita de ${appt.patient.name} (${appt.service.name}) es en menos de 2 horas y no ha confirmado.`,
          appointmentId: appt.id,
        });
      } catch (err) {
        this.logger.error(`Failed to create UNCONFIRMED_2H notification for ${appt.id}: ${err}`);
      }
    }
  }

  /**
   * Every 5 minutes: notify secretary of PENDING/CONFIRMED appointments
   * whose time has passed so they can mark result (COMPLETED or NO_SHOW).
   * De-duplicates by checking if a RESULT_NEEDED notification already exists.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async notifyResultNeeded(): Promise<void> {
    const now = new Date();

    const appointments = await this.prisma.appointment.findMany({
      where: {
        status: { in: ['PENDING', 'CONFIRMED'] },
        startsAt: { lte: now },
      },
      include: {
        patient: { select: { name: true } },
        service: { select: { name: true } },
      },
    });

    if (appointments.length === 0) return;

    const appointmentIds = appointments.map((a) => a.id);
    const existing = await this.prisma.notification.findMany({
      where: {
        type: NotificationType.RESULT_NEEDED,
        appointmentId: { in: appointmentIds },
      },
      select: { appointmentId: true },
    });
    const alreadyNotified = new Set(existing.map((n) => n.appointmentId));

    const toNotify = appointments.filter((a) => !alreadyNotified.has(a.id));
    if (toNotify.length === 0) return;

    this.logger.log(`Creating RESULT_NEEDED notifications for ${toNotify.length} appointment(s)`);

    for (const appt of toNotify) {
      try {
        await this.notifications.create({
          clinicId: appt.clinicId,
          type: NotificationType.RESULT_NEEDED,
          title: `¿Asistió ${appt.patient.name}?`,
          body: `Marque el resultado de la cita de ${appt.patient.name} (${appt.service.name}).`,
          appointmentId: appt.id,
        });
      } catch (err) {
        this.logger.error(`Failed to create RESULT_NEEDED notification for ${appt.id}: ${err}`);
      }
    }
  }
}
