import { Module } from '@nestjs/common';
import { ServicesController } from '@/modules/services/services.controller';
import { ServicesService } from '@/modules/services/services.service';

@Module({
  controllers: [ServicesController],
  providers: [ServicesService],
  exports: [ServicesService],
})
export class ServicesModule {}
