import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private app: admin.app.App | null = null;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {}

  onModuleInit() {
    try {
      this.getApp();
    } catch (err: any) {
      this.logger.error(`[Firebase] Error en inicialización inicial: ${err.message}`, err.stack);
    }
  }

  private getApp(): admin.app.App {
    if (this.app) {
      return this.app;
    }

    const appName = 'trackdeli-backend';
    const existingApp = admin.apps.find((a) => a?.name === appName);
    if (existingApp) {
      this.app = existingApp;
      return this.app;
    }

    const projectId =
      this.config.get<string>('FIREBASE_PROJECT_ID') ||
      process.env.FIREBASE_PROJECT_ID;
    const clientEmail =
      this.config.get<string>('FIREBASE_CLIENT_EMAIL') ||
      process.env.FIREBASE_CLIENT_EMAIL;
    let privateKey =
      this.config.get<string>('FIREBASE_PRIVATE_KEY') ||
      process.env.FIREBASE_PRIVATE_KEY ||
      '';

    // Limpiar comillas envolventes que Railway o .env puedan agregar
    if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
      privateKey = privateKey.slice(1, -1);
    }
    if (privateKey.startsWith("'") && privateKey.endsWith("'")) {
      privateKey = privateKey.slice(1, -1);
    }
    // Normalizar saltos de línea escapados a reales
    privateKey = privateKey.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      const msg = `Credenciales de Firebase incompletas o no configuradas: projectId=${!!projectId}, clientEmail=${!!clientEmail}, privateKey=${!!privateKey}`;
      this.logger.warn(`[Firebase] ${msg}`);
      throw new Error(msg);
    }

    this.app = admin.initializeApp(
      {
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      },
      appName,
    );

    this.logger.log(`[Firebase] Admin SDK inicializado exitosamente (app: ${appName}, project: ${projectId})`);
    return this.app;
  }

  async sendToToken(
    token: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<FirebaseSendResult> {
    try {
      const app = this.getApp();

      // Sanitizar data para asegurar que solo contenga strings y sin valores nulos/indefinidos
      const sanitizedData: Record<string, string> = {};
      if (data) {
        for (const [key, value] of Object.entries(data)) {
          if (value !== null && value !== undefined) {
            sanitizedData[key] = String(value);
          }
        }
      }

      const messageId = await app.messaging().send({
        token,
        notification: { title, body },
        data: sanitizedData,
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
      this.logger.log(`[FCM] Push enviado exitosamente al token ${token.substring(0, 20)}... (messageId: ${messageId})`);
      return { success: true, messageId };
    } catch (error: any) {
      this.logger.error(
        `[FCM] Error para token ${token.substring(0, 20)}...: ${error.message}`,
        error.stack,
      );

      // Limpiar tokens inválidos o expirados de la base de datos
      if (
        error.code === 'messaging/registration-token-not-registered' ||
        error.code === 'messaging/invalid-registration-token' ||
        error.code === 'messaging/invalid-argument'
      ) {
        this.logger.warn(
          `[FCM] Token inválido/expirado detectado. Eliminando de la BD: ${token.substring(0, 20)}...`,
        );
        try {
          await this.prisma.deviceToken.deleteMany({ where: { token } });
          this.logger.log(`[FCM] Token eliminado de la BD`);
        } catch (dbErr: any) {
          this.logger.error(`[FCM] Error eliminando token de la BD: ${dbErr.message}`);
        }
      }

      return {
        success: false,
        error: error.message,
        errorCode: error.code || error.errorInfo?.code,
      };
    }
  }

  async sendToMultiple(
    tokens: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<FirebaseMultipleSendResult> {
    if (!tokens.length) {
      return { sent: 0, failed: 0, total: 0, results: [], errors: [] };
    }

    const settled = await Promise.allSettled(
      tokens.map((token) => this.sendToToken(token, title, body, data)),
    );

    const results: FirebaseSendResult[] = [];
    const errors: string[] = [];
    let sent = 0;
    let failed = 0;

    for (const item of settled) {
      if (item.status === 'fulfilled') {
        results.push(item.value);
        if (item.value.success) {
          sent++;
        } else {
          failed++;
          if (item.value.error && !errors.includes(item.value.error)) {
            errors.push(item.value.error);
          }
        }
      } else {
        failed++;
        const errMsg = item.reason?.message || String(item.reason);
        results.push({ success: false, error: errMsg });
        if (!errors.includes(errMsg)) {
          errors.push(errMsg);
        }
      }
    }

    return {
      sent,
      failed,
      total: tokens.length,
      results,
      errors,
    };
  }
}

export interface FirebaseSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
  errorCode?: string;
}

export interface FirebaseMultipleSendResult {
  sent: number;
  failed: number;
  total: number;
  results: FirebaseSendResult[];
  errors: string[];
}

