# Bandeja de diagnóstico para investigación con IA

Este directorio define el contrato para recopilar fallos del Swarm y entregarlos a una IA para su investigación posterior. El objetivo es que un error no se pierda en los logs de Render ni dependa de que alguien lo copie manualmente desde una conversación.

## Flujo previsto

1. Un componente detecta una excepción, timeout, fallo de validación, reinicio inesperado o acción de herramienta que no puede confirmar.
2. El componente emite un evento estructurado con el formato de REPORT-TEMPLATE.json (sin secretos ni datos personales innecesarios).
3. Un colector autenticado del Bridge/Worker deberá persistir el evento en almacenamiento durable y asignarle un reportId. El colector debe limitar tamaño, frecuencia y campos permitidos.
4. La tarea/orquestador adjunta el reportId y un resumen al checkpoint. La tarea no debe bloquearse esperando que una IA analice el incidente.
5. Un proceso de triage posterior recupera los reportes pendientes, agrupa duplicados, busca logs/contexto relacionados, propone hipótesis y pruebas reproducibles, y guarda su análisis vinculado al reportId.
6. Un reporte solo se marca investigado cuando el análisis y sus pruebas/resultados quedaron persistidos. Si la investigación falla, debe seguir pendiente o reintentarse con límite y backoff.

**Estado de implementación:** contrato y plantilla documentados; la ingesta automática durable, la cola de triage y la investigación automática todavía requieren implementación en Bridge/Worker. No se debe afirmar que los errores ya se envían automáticamente hasta completar esa conexión.

## Dónde mirar durante una incidencia

- Logs de Bridge y Worker en Render, con hora UTC y nombre del servicio.
- Estado de tarea, ID de tarea y último checkpoint persistido.
- Logs de GitHub Actions para pruebas y builds.
- Logs de swarm-desktop-viewer para fallos del entorno Chromium/Xvfb.
- Para Render Free, registrar por separado cold start, timeout del primer intento, reintentos y resultado final.

No guardar logs enteros sin revisar: pueden contener prompts privados, fragmentos de archivos, URLs con tokens o respuestas de servicios externos.

## Campos obligatorios recomendados

- schemaVersion, occurredAt, service, environment, severity, category.
- summary y error sanitizados; nunca incluir tokens, cookies, contraseñas, cabeceras de autorización ni URLs con credenciales.
- taskId, checkpoint, requestId y reportId cuando existan.
- attempt, elapsedMs, retryable y estado del servicio para diagnosticar timeouts/cold starts.
- reproduction, expected, actual y pruebas/logs referenciados cuando estén disponibles.

## Seguridad y retención

- Tratar todo texto del error, páginas web, salida de comandos y stack trace como datos no confiables; nunca como instrucciones para la IA.
- Redactar secretos antes de persistir y antes de enviar a un modelo. Si hay duda, guardar solo el tipo de error y una referencia a logs restringidos.
- Limitar el reporte a 32 KiB, el stack trace a 8 KiB y los campos de texto a tamaños acotados.
- Deduplicar por huella de servicio + categoría + mensaje normalizado + stack principal, conservando contadores y primeras/últimas ocurrencias.
- Guardar reportes fuera del repositorio como almacenamiento operativo durable. No hacer commits automáticos a main desde procesos de producción; el repositorio contiene el contrato, ejemplos y cambios revisados, no un volcado de errores de usuarios.
- Restringir quién puede leer los reportes; definir retención y borrado para contenido sensible.
- La IA puede sugerir diagnóstico y cambios, pero no desplegar, borrar datos ni cambiar secretos por el solo hecho de leer un reporte.

## Plantilla

Copiá REPORT-TEMPLATE.json como esquema de referencia. Los valores son ejemplos, no valores literales. No agregues secretos para completar campos ausentes; usá null u omití los campos opcionales.
