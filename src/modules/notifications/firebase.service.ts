import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private app: admin.app.App;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {}

  onModuleInit() {
    if (!admin.apps.length) {
      this.app = admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
      });
      this.logger.log(`[Firebase] Admin SDK inicializado para proyecto: ${process.env.FIREBASE_PROJECT_ID}`);
    } else {
      this.app = admin.apps[0]!;
    }
  }

  async sendToToken(
    token: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    try {
      await admin.messaging(this.app).send({
        token,
        notification: { title, body },
        data: data || {},
        android: {
          priority: 'high',
          notification: {
            sound: 'default',
            channelId: 'trackdeli_notifications',
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
            },
          },
        },
      });
      this.logger.log(`[FCM] Push enviado exitosamente al token ${token.substring(0, 20)}...`);
    } catch (error: any) {
      this.logger.error(`[FCM] Error para token ${token.substring(0, 20)}...: ${error.message}`);
      
      // Limpiar tokens inválidos o expirados de la base de datos
      if (
        error.code === 'messaging/registration-token-not-registered' ||
        error.code === 'messaging/invalid-registration-token' ||
        error.code === 'messaging/invalid-argument'
      ) {
        this.logger.warn(`[FCM] Token inválido/expirado detectado. Eliminando de la BD: ${token.substring(0, 20)}...`);
        try {
          await this.prisma.deviceToken.deleteMany({ where: { token } });
          this.logger.log(`[FCM] Token eliminado de la BD`);
        } catch (dbErr: any) {
          this.logger.error(`[FCM] Error eliminando token de la BD: ${dbErr.message}`);
        }
      }
    }
  }

  async sendToMultiple(
    tokens: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    if (!tokens.length) return;

    await Promise.allSettled(
      tokens.map(token => this.sendToToken(token, title, body, data))
    );
  }
}
