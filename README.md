# trackdeli-api
Backend de plataforma SaaS de tracking en tiempo real para delivery propio de negocios locales.

## Requisitos
- Node.js 20+
- Docker y Docker Compose
- npm

## Instrucciones para levantar el proyecto

1. Copiar el archivo de variables de entorno:
   ```bash
   cp .env.example .env
   ```
2. Levantar la base de datos (PostgreSQL + PostGIS) y Redis:
   ```bash
   docker compose up -d
   ```
3. Instalar dependencias:
   ```bash
   npm install
   ```
4. Generar y aplicar migraciones de Prisma:
   ```bash
   npx prisma migrate dev --name init
   ```
5. Insertar datos de prueba (Seed):
   ```bash
   npx prisma db seed
   ```
6. Iniciar el servidor de desarrollo:
   ```bash
   npm run start:dev
   ```

## Endpoints Disponibles
Todos los endpoints están bajo el prefijo `/api/v1`.
Endpoints de health check:
- `GET /api/v1/auth/health`
- `GET /api/v1/users/health`
- `GET /api/v1/businesses/health`
- `GET /api/v1/orders/health`
- `GET /api/v1/tracking/health`
- `GET /api/v1/notifications/health`
- `GET /api/v1/upload/health`
- `GET /api/v1/ratings/health`

## Estructura de carpetas
- `src/`: Código fuente de la aplicación NestJS.
- `src/modules/`: Módulos principales de la aplicación.
- `src/common/`: Archivos compartidos (decorators, guards, filters, interceptors).
- `src/config/`: Configuración global y validación de variables de entorno.
- `prisma/`: Esquema de la base de datos y script de seeding.
