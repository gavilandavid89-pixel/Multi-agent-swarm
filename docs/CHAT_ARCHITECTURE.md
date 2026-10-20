# Arquitectura de chats independientes

## Objetivo

Separar el historial de conversaciones del historial de tareas del comité. Un chat es una conversación persistente propiedad de una cuenta; una tarea sigue siendo una ejecución con estado, checkpoints, presupuesto, artefactos y validación. No se debe crear una tarea de Swarm solo para que una conversación aparezca en el menú de chats.

## Estado de esta entrega

Esta rama integra persistencia, API, interfaz independiente y envío de turnos al Worker. La implementación está en validación automática; no debe considerarse lista para producción hasta que terminen CI y las pruebas de integración.

## Componentes y responsabilidades

- **Frontend (apps/web/public)**: menú principal, lista de chats y vista de mensajes. No decide la propiedad de los datos ni guarda secretos.
- **Bridge (apps/bridge)**: autentica sesiones, verifica la propiedad de cada chat y expone la API pública.
- **conversationStore.js**: persistencia PostgreSQL de conversaciones y mensajes.
- **Worker (apps/worker)**: procesa turnos de chat mediante una ruta interna autenticada, mantiene estado persistente y recupera turnos interrumpidos al arrancar. El cliente no puede elegir herramientas privilegiadas, roles internos ni secretos.
- **Tareas (user_job_ownership)**: conservan su propio historial y permisos; los endpoints de tareas no se reutilizan para identificar chats.

## Modelo de datos

### conversations

- id: UUID generado por PostgreSQL.
- user_id: propietario, con FK a app_users y borrado en cascada si se elimina la cuenta.
- title: entre 1 y 120 caracteres.
- created_at, updated_at: orden y actividad.
- archived_at: archivado reversible, no borrado.
- last_message_at: marca de actividad, actualizada al guardar mensajes.

### conversation_messages

- id: secuencia monotónica para paginar sin cargar toda la conversación.
- conversation_id: FK a conversations, con borrado en cascada.
- role: restringido a user, assistant, system o tool.
- content: texto con un límite de 100.000 caracteres por mensaje.
- metadata: JSONB para datos estructurados no secretos.
- idempotency_key: índice único parcial por conversación para que los reintentos no dupliquen un mensaje.
- created_at: orden cronológico.

La tabla `conversation_turns` registra idempotencia, estado, contador de intentos, errores recuperables y referencias a mensajes de usuario/asistente. La creación del esquema es idempotente: usa CREATE TABLE/INDEX IF NOT EXISTS y no elimina ni transforma datos existentes.

## API autenticada disponible en esta rama

Todas estas rutas requieren la sesión Bearer existente. La autorización se aplica a nivel de consulta con user_id; un UUID válido no es prueba de propiedad.

- GET /api/chats?limit=25&offset=0&archived=false: lista chats propios, paginados.
- POST /api/chats con un título opcional: crea un chat.
- GET /api/chats/:chatId: obtiene metadatos de un chat propio.
- PATCH /api/chats/:chatId con title: renombra un chat activo.
- PATCH /api/chats/:chatId con archived: archiva o restaura.
- GET /api/chats/:chatId/messages?limit=50&beforeId=123: lee mensajes paginados, solo si el chat pertenece a la cuenta.\n- POST /api/chats/:chatId/messages con `message` y `Idempotency-Key`: persiste el mensaje y encola un turno.\n- GET /api/chats/:chatId/turns/:turnId: consulta el estado durable; los turnos pendientes vuelven a intentar despertar al Worker.

Los endpoints de chat usan el parámetro :chatId, no :id: el Bridge ya tiene un app.param('id') que comprueba la propiedad de tareas. Reutilizar :id aquí activaría la validación equivocada.

## Contrato de turnos implementado

1. Verificar propietario y estado del chat antes de enviar un turno.
2. Persistir el mensaje del usuario con una clave de idempotencia antes de ejecutar el turno, para que reintentos de red no creen mensajes duplicados.
3. Vincular el turno del Worker a conversation_id, sin convertirlo automáticamente en una tarea de desarrollo.
4. Guardar respuesta, estado y errores recuperables de forma persistente; el cliente debe poder recuperar el turno tras recargar o reconectar.
5. Mantener el secreto Bridge–Worker únicamente en servidor y validar el tamaño del mensaje.
6. No aceptar mensajes assistant del cliente ni confiar en roles, propietario o metadatos declarados por el navegador.
7. Usar paginación por cursor y límites de tamaño; no devolver la conversación entera en cada actualización.
8. Archivar por defecto en lugar de borrar. Si en el futuro se añade borrado permanente, debe ser una acción explícita con confirmación y política de retención clara.

## Siguiente paso

Conectar el envío de mensajes al Worker mediante un contrato de turnos de conversación, con idempotencia persistente y recuperación de ejecuciones; después añadir la UI y pruebas E2E para dos usuarios distintos, reintentos, archivo/restauración y reconexión. La API de tareas y su historial deben seguir funcionando sin cambios.
