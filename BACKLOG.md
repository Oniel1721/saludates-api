# Backend — Tareas pendientes (post-MVP)

Mejoras identificadas pero no críticas para el lanzamiento inicial.

---

## Rendimiento

- **Paginación en listas** — `/appointments`, `/patients`, `/conversations` y `/notifications`
  devuelven todos los registros sin límite. Agregar `cursor`/`skip`+`take` con Prisma cuando
  el volumen lo justifique.

---

## Seguridad

- **Rate limiting en auth** — `POST /auth/google/verify` no tiene throttling.
  Instalar `@nestjs/throttler` y aplicar un límite razonable (ej. 10 req/min).

---

## Operaciones / DevEx

- **Swagger / OpenAPI** — Agregar `@nestjs/swagger` para documentar los endpoints
  y facilitar la integración con el frontend y futuros clientes.

- **Health check** — `GET /health` que verifique DB y retorne `{ status: 'ok' }`.
  Necesario para deployments con Docker, Railway, etc.

- **Modelo de Claude configurable** — `claude-haiku-4-5-20251001` está hardcodeado
  en `intent.service.ts`. Mover a `EnvironmentService` para poder cambiarlo sin
  tocar código.

- **Logging de requests** — Agregar un middleware de logging HTTP para tener
  visibilidad en producción (timing, status codes, path).

---

## Calidad de código

- **Tests de controllers** — Actualmente solo hay unit tests de services.
  Los controllers no están cubiertos (guards, query params, respuestas HTTP).

- **Flujo `QUERYING_SERVICES`** — No tiene un `FlowHandler` registrado; cae al
  fallback genérico de Claude. Implementar un handler estructurado que liste
  servicios y precios directamente.

- **`flowState` sin validación en runtime** — El JSON del estado del bot se castea
  con `as never`. Agregar Zod o guards de tipo por flow para detectar estados corruptos.

- **Retry en mensajes WhatsApp** — Los mensajes fallidos (fire-and-forget) se pierden
  silenciosamente. Evaluar una cola simple (BullMQ) o al menos un reintento.

---

## Base de datos

- **Limpieza de notificaciones antiguas** — Las notificaciones se acumulan
  indefinidamente. Agregar un cron semanal que archive/elimine notificaciones
  con más de 30 días.
