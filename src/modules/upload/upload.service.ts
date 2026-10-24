import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
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
    this.logger.log(`[uploadPhoto] Iniciando: folder=${folder}, tamañoOriginal=${file.size} bytes`);

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
      this.logger.log(`[uploadPhoto] OK foto subida: key=${key}, tamañoComprimido=${compressed.length} bytes`);
      return url;
    } catch (error: any) {
      this.logger.error(`[uploadPhoto] ERROR al subir foto: folder=${folder}, error=${error.message}`, error.stack);
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

  async uploadReceiptPdf(key: string, buffer: Buffer): Promise<void> {
    this.logger.log(`[uploadReceiptPdf] Subiendo PDF a R2: key=${key}, size=${buffer.length} bytes`);
    try {
      await this.s3Client.send(new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: buffer,
        ContentType: 'application/pdf',
      }));
      this.logger.log(`[uploadReceiptPdf] OK PDF subido a R2: key=${key}`);
    } catch (error: any) {
      this.logger.error(`[uploadReceiptPdf] ERROR al subir PDF a R2: key=${key}, error=${error.message}`, error.stack);
      throw error;
    }
  }

  async getReceiptPdfStream(key: string): Promise<{ stream: NodeJS.ReadableStream; contentLength?: number }> {
    try {
      const response = await this.s3Client.send(new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }));
      return {
        stream: response.Body as NodeJS.ReadableStream,
        contentLength: response.ContentLength,
      };
    } catch (error: any) {
      this.logger.error(`[getReceiptPdfStream] ERROR al obtener PDF de R2: key=${key}, error=${error.message}`, error.stack);
      throw error;
    }
  }

  async deleteReceiptPdf(key: string): Promise<void> {
    this.logger.log(`[deleteReceiptPdf] Eliminando PDF de R2: key=${key}`);
    try {
      await this.s3Client.send(new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }));
    } catch (error: any) {
      this.logger.warn(`[deleteReceiptPdf] Advertencia al borrar PDF de R2: key=${key}, error=${error.message}`);
    }
  }
}
