# Auditoría de `comite-database`

Fecha: 17 de octubre de 2026.

## Identidad y uso

El diagnóstico de solo lectura ejecutado desde el Worker confirmó `current_database() = comite_database` y `current_user = comite_database_user`. Por lo tanto, la variable `DATABASE_URL` del Worker apunta a Render PostgreSQL `comite-database`.

## Inventario observado

En el instante de la inspección:

- `public.jobs`: 6 filas. Columnas: `id`, `status`, `stage`, `progress`, `attempt`, `created_at`, `updated_at`, `error`, `encrypted_payload` (`bytea`, cifrado por la aplicación).
- `public.job_request_idempotency`: 1 fila. Columnas: `idempotency_key`, `request_hash`, `job_id`, `created_at`.
- Integridad: claves primarias en `jobs.id` y `job_request_idempotency.idempotency_key`; unicidad en `job_request_idempotency.job_id`.
- Índices: claves primarias y orden por fecha de creación/actualización en `jobs`.
- No se detectaron claves foráneas, vistas, vistas materializadas, secuencias ni otras tablas u objetos de usuario en el inventario.

Los conteos pueden cambiar durante el uso normal del servicio.

## Interpretación y límites

El esquema coincide con el almacenamiento de tareas y checkpoints que inicializa `apps/worker/services/store.js`. Esto confirma que la base está en uso por el Swarm. No existen tablas explícitas de integrantes, deliberaciones o votos en el esquema observado; eso no demuestra que no haya información relacionada con el consejo dentro de los payloads cifrados. El diagnóstico no leyó ni descifró filas de negocio.

No se modificaron datos ni el esquema. No renombrar, vaciar, migrar ni cambiar la URL de esta base sin definir la arquitectura deseada y verificar una copia de seguridad.

## Diagnóstico temporal retirado

La inspección se ejecutó antes de inicializar el almacén, emitió metadatos solamente y no expuso la URL de conexión ni secretos. El código temporal se retiró de `apps/worker/server.js` y `apps/worker/services/store.js` después de recoger los resultados. Confirmar que el nuevo despliegue quede activo y que ya no aparezca el log `[worker][database_schema_diagnostic]`.
