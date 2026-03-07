import {
  Controller,
  Get,
  Put,
  Patch,
  Post,
  Delete,
  Param,
  Body,
  Query,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { AvailabilityService } from '@/modules/availability/availability.service';
import { BulkScheduleDto } from '@/modules/availability/dto/bulk-schedule.dto';
import { UpdateScheduleDayDto } from '@/modules/availability/dto/update-schedule-day.dto';
import { CreateTimeBlockDto } from '@/modules/availability/dto/create-time-block.dto';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { ClinicGuard } from '@/modules/auth/guards/clinic.guard';

@Controller('clinics/:clinicId')
@UseGuards(JwtAuthGuard, ClinicGuard)
export class AvailabilityController {
  constructor(private availability: AvailabilityService) {}

  // ── Schedule (T-07) ─────────────────────────────────────────────────────────

  @Get('schedule')
  getSchedule(@Param('clinicId') clinicId: string) {
    return this.availability.getSchedule(clinicId);
  }

  @Put('schedule')
  upsertSchedule(@Param('clinicId') clinicId: string, @Body() dto: BulkScheduleDto) {
    return this.availability.upsertSchedule(clinicId, dto);
  }

  @Patch('schedule/:dayOfWeek')
  updateDay(
    @Param('clinicId') clinicId: string,
    @Param('dayOfWeek', ParseIntPipe) dayOfWeek: number,
    @Body() dto: UpdateScheduleDayDto,
  ) {
    return this.availability.updateDay(clinicId, dayOfWeek, dto);
  }

  // ── Time Blocks (T-08) ──────────────────────────────────────────────────────

  @Get('time-blocks')
  getTimeBlocks(
    @Param('clinicId') clinicId: string,
    @Query('upcoming') upcoming?: string,
  ) {
    return this.availability.getTimeBlocks(clinicId, upcoming === 'true');
  }

  @Post('time-blocks')
  createTimeBlock(
    @Param('clinicId') clinicId: string,
    @Body() dto: CreateTimeBlockDto,
  ) {
    return this.availability.createTimeBlock(clinicId, dto);
  }

  @Delete('time-blocks/:blockId')
  deleteTimeBlock(
    @Param('clinicId') clinicId: string,
    @Param('blockId') blockId: string,
  ) {
    return this.availability.deleteTimeBlock(clinicId, blockId);
  }
}
