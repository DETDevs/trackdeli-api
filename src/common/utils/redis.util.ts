import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const globalRedisLogger = new Logger('RedisSafety');
const lastLogTimeByClient = new Map<string, number>();

/**
 * Determina si Redis está habilitado en la aplicación.
 * Regla:
 * 1. Si REDIS_ENABLED está definido: toma su valor booleano ('true' -> true, 'false' -> false).
 * 2. Si no está definido: true si existe REDIS_URL con contenido, false en caso contrario.
 */
export function isRedisEnabled(configService?: ConfigService): boolean {
  const getEnv = (key: string): string | undefined => {
    if (configService) {
      return configService.get<string>(key);
    }
    return process.env[key];
  };

  const redisEnabledEnv = getEnv('REDIS_ENABLED');
  if (redisEnabledEnv !== undefined && redisEnabledEnv !== '') {
    return redisEnabledEnv.trim().toLowerCase() === 'true';
  }

  const redisUrl = getEnv('REDIS_URL');
  if (redisUrl && redisUrl.trim() !== '') {
    return true;
  }

  return false;
}

/**
 * Sanea un error de Redis para evitar la fuga de credenciales (contraseña en comando auth o en URL).
 */
export function sanitizeRedisError(err: any): string {
  if (!err) return 'Error desconocido de Redis';

  // 1. Redactar argumentos de comandos (en especial comando 'auth')
  if (err.command && Array.isArray(err.command.args)) {
    err.command.args = ['***REDACTED***'];
  }

  let message = typeof err.message === 'string' ? err.message : String(err);

  // 2. Redactar contraseñas en URLs de conexión redis:// o rediss://
  message = message.replace(/(rediss?:\/\/[^:]+:)([^@]+)(@)/gi, '$1***$3');

  // 3. Redactar contraseñas si aparecen en texto de auth
  message = message.replace(/auth\s+[^\s\r\n]+/gi, 'auth ***');

  return message;
}

/**
 * Emite un log de advertencia con rate limit de 1 aviso por minuto por cliente,
 * evitando la inundación de logs en Railway (hasta 500 logs/seg durante caídas).
 */
export function logThrottledRedisError(clientName: string, err: any, customLogger?: Logger): void {
  const now = Date.now();
  const lastLog = lastLogTimeByClient.get(clientName) || 0;
  const ONE_MINUTE_MS = 60000;

  const sanitizedMessage = sanitizeRedisError(err);

  if (now - lastLog >= ONE_MINUTE_MS) {
    lastLogTimeByClient.set(clientName, now);
    const logger = customLogger || globalRedisLogger;
    logger.warn(
      `[${clientName}] Advertencia de conexión Redis: ${sanitizedMessage} (próximos avisos silenciados por 1 minuto)`,
    );
  }
}

/**
 * Adjunta un listener de error seguro a un cliente ioredis o cola Bull para evitar
 * excepciones no manejadas y registrar avisos con rate limit y saneamiento.
 */
export function attachSafeRedisErrorHandler(client: any, clientName: string, customLogger?: Logger): void {
  if (!client || typeof client.on !== 'function') return;

  client.on('error', (err: any) => {
    logThrottledRedisError(clientName, err, customLogger);
  });
}

let isGlobalSafetySetup = false;

/**
 * Configura interceptores a nivel de proceso (unhandledRejection y uncaughtException)
 * para capturar y neutralizar cualquier error no manejado proveniente de Redis (ReplyError)
 * sin permitir que Node.js termine el proceso de la API.
 */
export function setupGlobalRedisSafety(): void {
  if (isGlobalSafetySetup) return;
  isGlobalSafetySetup = true;

  process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    const isRedisError =
      reason &&
      (reason.name === 'ReplyError' ||
        reason.name === 'MaxRetriesPerRequestError' ||
        (typeof reason.message === 'string' &&
          (reason.message.includes('Redis') ||
            reason.message.includes('max requests limit exceeded') ||
            reason.message.includes('ECONNREFUSED'))));

    if (isRedisError) {
      logThrottledRedisError('UnhandledRejection:Redis', reason);
      // Neutralizado sin tirar el proceso
      return;
    }

    // Para otros errores no relacionados a Redis, se loguea la traza normalmente
    globalRedisLogger.error(
      `Unhandled Promise Rejection no relacionado a Redis: ${reason?.message || reason}`,
      reason instanceof Error ? reason.stack : undefined,
    );
  });

  process.on('uncaughtException', (err: any) => {
    const isRedisError =
      err &&
      (err.name === 'ReplyError' ||
        err.name === 'MaxRetriesPerRequestError' ||
        (typeof err.message === 'string' &&
          (err.message.includes('Redis') ||
            err.message.includes('max requests limit exceeded'))));

    if (isRedisError) {
      logThrottledRedisError('UncaughtException:Redis', err);
      // Evitar que el proceso caiga por Redis
      return;
    }

    // Para excepciones no capturadas de otro origen, loguear y permitir salida
    globalRedisLogger.error(`Uncaught Exception: ${err?.message || err}`, err?.stack);
    process.exit(1);
  });
}

/**
 * Genera opciones de ioredis optimizadas para bajo consumo de comandos y reintentos moderados.
 */
export function getOptimizedRedisOptions(configService: ConfigService) {
  const redisUrl = configService.get<string>('REDIS_URL');
  const baseOptions: any = {
    enableReadyCheck: false,
    showFriendlyErrorStack: false,
    lazyConnect: true,
    retryStrategy: (times: number) => {
      // Reintentos espaciados: mínimo 5s, máximo 30s. No quemar peticiones ni saturar el servidor.
      return Math.min(Math.max(times * 2000, 5000), 30000);
    },
  };

  if (redisUrl && redisUrl.trim()) {
    return {
      url: redisUrl.trim(),
      options: {
        ...baseOptions,
        maxRetriesPerRequest: null,
      },
    };
  }

  const host = configService.get<string>('REDIS_HOST', 'localhost');
  const port = Number(configService.get<number>('REDIS_PORT', 6379));
  const password = configService.get<string>('REDIS_PASSWORD') || undefined;
  const tls = configService.get<string>('REDIS_TLS') === 'true' ? {} : undefined;

  return {
    options: {
      ...baseOptions,
      host,
      port,
      password,
      tls,
      maxRetriesPerRequest: null,
    },
  };
}

// Activar automáticamente la protección global contra excepciones no capturadas de Redis
setupGlobalRedisSafety();
