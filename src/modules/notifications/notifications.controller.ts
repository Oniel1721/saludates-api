import { Controller, Get, Post, Param, Query, UseGuards } from '@nestjs/common';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { ClinicGuard } from '@/modules/auth/guards/clinic.guard';

@Controller('clinics/:clinicId/notifications')
@UseGuards(JwtAuthGuard, ClinicGuard)
export class NotificationsController {
  constructor(private notifications: NotificationsService) {}

  // ?unread=true for badge count / unread-only view
  @Get()
  findAll(
    @Param('clinicId') clinicId: string,
    @Query('unread') unread?: string,
  ) {
    return this.notifications.findAll(clinicId, unread === 'true');
  }

  @Post(':notificationId/read')
  markRead(
    @Param('clinicId') clinicId: string,
    @Param('notificationId') notificationId: string,
  ) {
    return this.notifications.markRead(clinicId, notificationId);
  }

  @Post('read-all')
  markAllRead(@Param('clinicId') clinicId: string) {
    return this.notifications.markAllRead(clinicId);
  }
}
