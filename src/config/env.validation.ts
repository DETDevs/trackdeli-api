import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test', 'provision')
    .default('development'),
  PORT: Joi.number().default(3000),
  DATABASE_URL: Joi.string().required(),
  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().default(6379),
  JWT_SECRET: Joi.string().required(),
  JWT_EXPIRATION: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_REFRESH_EXPIRATION: Joi.string().required(),
  R2_ACCOUNT_ID: Joi.string().optional().allow(''),
  R2_ACCESS_KEY_ID: Joi.string().optional().allow(''),
  R2_SECRET_ACCESS_KEY: Joi.string().optional().allow(''),
  R2_BUCKET_NAME: Joi.string().optional().allow(''),
  R2_PUBLIC_URL: Joi.string().optional().allow(''),
  FIREBASE_PROJECT_ID: Joi.string().optional().allow(''),
  FIREBASE_CLIENT_EMAIL: Joi.string().optional().allow(''),
  FIREBASE_PRIVATE_KEY: Joi.string().optional().allow(''),
  MAPBOX_ACCESS_TOKEN: Joi.string().optional().allow(''),
  CORS_ORIGINS: Joi.string().required(),
});
