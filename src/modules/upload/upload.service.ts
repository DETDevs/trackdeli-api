import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import * as sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private s3Client: S3Client;
  private bucketName: string;
  private publicUrl: string;

  constructor(private config: ConfigService) {
    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.get<string>('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.get<string>('R2_ACCESS_KEY_ID') || '',
        secretAccessKey: config.get<string>('R2_SECRET_ACCESS_KEY') || '',
      },
    });
    this.bucketName = config.get<string>('R2_BUCKET_NAME') || '';
    this.publicUrl = config.get<string>('R2_PUBLIC_URL') || '';
  }

  async uploadPhoto(
    file: Express.Multer.File,
    folder: string,
  ): Promise<string> {
    this.logger.log(`[Upload] Subiendo foto: folder=${folder}, tamaño original=${file.size} bytes`);

    try {
      const compressed = await (sharp as any)(file.buffer)
        .resize({ width: 1200, withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();

      const key = `${folder}/${uuidv4()}.jpg`;

      await this.s3Client.send(new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: compressed,
        ContentType: 'image/jpeg',
      }));

      const url = `${this.publicUrl}/${key}`;
      this.logger.log(`[Upload] Foto subida exitosamente: key=${key}, url=${url}`);
      return url;
    } catch (error: any) {
      this.logger.error(`[Upload] Error al subir foto: folder=${folder}, error=${error.message}`);
      throw error;
    }
  }

  async deletePhoto(photoUrl: string): Promise<void> {
    const key = photoUrl.replace(`${this.publicUrl}/`, '');
    await this.s3Client.send(new DeleteObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    }));
  }
}
