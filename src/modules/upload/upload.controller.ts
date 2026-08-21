import { Controller, Get, Post, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadService } from './upload.service';

@Controller('upload')
export class UploadController {
  constructor(private readonly service: UploadService) {}

  @Get('health')
  healthCheck() {
    return { status: 'ok', module: 'upload' };
  }

  @Post()
  @UseInterceptors(FileInterceptor('file'))
  uploadFile(@UploadedFile() file: Express.Multer.File) {
    return { message: 'upload placeholder', filename: file?.originalname };
  }
}

