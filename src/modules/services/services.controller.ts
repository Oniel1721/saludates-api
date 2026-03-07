import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ServicesService } from '@/modules/services/services.service';
import { CreateServiceDto } from '@/modules/services/dto/create-service.dto';
import { UpdateServiceDto } from '@/modules/services/dto/update-service.dto';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { ClinicGuard } from '@/modules/auth/guards/clinic.guard';

@Controller('clinics/:clinicId/services')
@UseGuards(JwtAuthGuard, ClinicGuard)
export class ServicesController {
  constructor(private services: ServicesService) {}

  @Post()
  create(@Param('clinicId') clinicId: string, @Body() dto: CreateServiceDto) {
    return this.services.create(clinicId, dto);
  }

  @Get()
  findAll(
    @Param('clinicId') clinicId: string,
    @Query('includeArchived') includeArchived?: string,
  ) {
    return this.services.findAll(clinicId, includeArchived === 'true');
  }

  @Get(':serviceId')
  findOne(@Param('clinicId') clinicId: string, @Param('serviceId') serviceId: string) {
    return this.services.findOne(clinicId, serviceId);
  }

  @Patch(':serviceId')
  update(
    @Param('clinicId') clinicId: string,
    @Param('serviceId') serviceId: string,
    @Body() dto: UpdateServiceDto,
  ) {
    return this.services.update(clinicId, serviceId, dto);
  }

  // Archives the service (soft delete — services are never physically deleted)
  @Delete(':serviceId')
  archive(@Param('clinicId') clinicId: string, @Param('serviceId') serviceId: string) {
    return this.services.archive(clinicId, serviceId);
  }
}
