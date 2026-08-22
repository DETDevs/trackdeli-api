import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';

@Injectable()
export class FirebaseService implements OnModuleInit {
  private app: admin.app.App;

  constructor(private config: ConfigService) { }

  onModuleInit() {
    if (!admin.apps.length) {
      this.app = admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
      });
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
    } catch (error) {
      console.error(`FCM error for token ${token.substring(0, 20)}...:`, error.message);
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
