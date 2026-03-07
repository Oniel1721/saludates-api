import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ClinicsService } from '@/modules/clinics/clinics.service';
import { CreateClinicDto } from '@/modules/clinics/dto/create-clinic.dto';
import { UpdateClinicDto } from '@/modules/clinics/dto/update-clinic.dto';
import { UpdateClinicEmailsDto } from '@/modules/clinics/dto/update-clinic-emails.dto';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { SuperadminGuard } from '@/modules/auth/guards/superadmin.guard';
import { ClinicGuard } from '@/modules/auth/guards/clinic.guard';

@Controller('clinics')
export class ClinicsController {
  constructor(private clinics: ClinicsService) {}

  // Superadmin creates a clinic and assigns authorized emails
  @Post()
  @UseGuards(JwtAuthGuard, SuperadminGuard)
  create(@Body() dto: CreateClinicDto) {
    return this.clinics.create(dto);
  }

  // Superadmin lists all clinics
  @Get()
  @UseGuards(JwtAuthGuard, SuperadminGuard)
  findAll() {
    return this.clinics.findAll();
  }

  // Clinic user or superadmin gets their clinic
  @Get(':clinicId')
  @UseGuards(JwtAuthGuard, ClinicGuard)
  findOne(@Param('clinicId') clinicId: string) {
    return this.clinics.findOne(clinicId);
  }

  // Clinic user or superadmin updates name/address (T-05)
  @Patch(':clinicId')
  @UseGuards(JwtAuthGuard, ClinicGuard)
  update(@Param('clinicId') clinicId: string, @Body() dto: UpdateClinicDto) {
    return this.clinics.update(clinicId, dto);
  }

  // Superadmin updates authorized emails (T-03)
  @Put(':clinicId/emails')
  @UseGuards(JwtAuthGuard, SuperadminGuard)
  updateEmails(@Param('clinicId') clinicId: string, @Body() dto: UpdateClinicEmailsDto) {
    return this.clinics.updateEmails(clinicId, dto);
  }
}
