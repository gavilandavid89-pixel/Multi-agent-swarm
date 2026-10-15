# Separación segura del historial del Swarm

## Estado actual

- La base de cuentas de Swarm es `swarm` en el proyecto Neon `multi-agent-swarm`.
- Se creó la base vacía `swarm_history` en la rama de producción de ese mismo proyecto, con el rol existente `swarm_app`.
- La base `swarm` conserva sus seis tablas de cuentas/sesiones/invitaciones/APIs/propiedad. No se modificó.
- `swarm_history` todavía no contiene tablas ni trabajos. El worker crea `jobs` e índices al iniciar mediante `initStore()`.
- No se cambiaron variables de Render, no se copiaron filas y no se modificó ninguna base de Comité.


## Ramas de Neon verificadas (2026-10-15)

- La rama primaria `production` (`br-holy-feather-b5q9c9yd`) contiene las bases `swarm` y `swarm_history`.
- La rama `mcp-migration-2026-10-14T20-25-19` (`br-sparkling-mode-b5yvhkhg`) contiene únicamente `swarm`; no tiene una base `swarm_history`.
- La base `swarm_history` de producción está vacía de tablas en esta revisión. Por tanto, crear la base no equivale a haber migrado el historial.
- No eliminar ni restablecer la rama de migración solo porque parezca una copia: antes hay que identificar qué datos contiene y qué propósito cumple.
- La inspección de metadatos de Render confirma que ambos servicios de Swarm están configurados con plan gratuito y que el campo efectivo `healthCheckPath` está vacío, aunque este repositorio declara `/readyz` en `render.yaml`. Hay que corregir esa configuración en Render y verificarla por separado; no se debe intentar resolverlo modificando variables de entorno.

## Contrato de conexiones

- `SWARM_DATABASE_URL`: base `swarm`; cuentas, sesiones, invitaciones, APIs cifradas y propiedad de tareas.
- `DATABASE_URL`: base `swarm_history); trabajos, checkpoints, historial y payload cifrado.
- `HISTORY_ENCRYPTION_KEY`: debe mantenerse idéntica para poder descifrar los payloads históricos existentes. No imprimirla en logs ni rotarla durante la migración.

## Procedimiento obligatorio antes de cambiar Render

1. Identificar el origen de `DATABASE_URL` en el Worker usando solo metadatos (host/base/servicio), nunca copiar credenciales a logs o documentación.
2. Confirmar el alcance de los registros de origen. El destino no debe recibir trabajos de Comité ni datos ajenos a Swarm. No copiar indiscriminadamente todas las filas de una base compartida.
3. Diseñar una exportación/importación que conserve exactamente `id`, estados, marcas de tiempo, errores y bytes de `encrypted_payload`. No descifrar ni volver a cifrar durante la copia.
4. Importar primero en `swarm_history` sin sobrescribir IDs existentes. Verificar recuentos por estado, IDs únicos, tamaños y que el worker pueda descifrar una muestra de payloads con la clave vigente.
5. Probar en una rama/base aislada antes del corte. La prueba debe confirmar lectura, actualización, checkpoint y reanudación de un trabajo de prueba.
6. Cambiar únicamente `DATABASE_URL` del servicio `swarm-worker` al destino validado. Mantener `SWARM_DATABASE_URL` apuntando a `swarm`. No editar servicios de Comité ni otros servicios de Render.
7. Verificar `/readyz`, logs de inicio sin secretos, historial y recuperación de tareas. Mantener el origen intacto como reversión hasta cerrar la auditoría.

## Criterios para dar la migración por terminada

- Ninguna variable de conexión de Comité fue modificada.
- Las tareas Swarm que se decida conservar aparecen en destino y sus payloads se pueden descifrar.
- Cuentas, APIs cifradas, sesiones y propiedad siguen en `swarm`.
- Las tareas nuevas se escriben en `swarm_history`.
- Se comprobó un checkpoint persistente y la reanudación después de reiniciar el worker.

> La creación de `swarm_history` no completa la migración. No cambiar `DATABASE_URL` hasta que el origen y el conjunto exacto de trabajos a conservar estén verificados.
