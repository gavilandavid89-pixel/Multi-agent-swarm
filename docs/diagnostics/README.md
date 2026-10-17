# Inbox de errores para investigación de IA

## Estado

El colector persistente ya existe en `apps/worker`: `POST /internal/diagnostics`, `GET /internal/diagnostics` y `GET /internal/diagnostics/:id`. Estas rutas están detrás de la autenticación interna Bridge→Worker. Los informes se guardan en PostgreSQL en `diagnostic_reports`; los errores de escritura devuelven `503` para reintentos seguros.

El colector todavía no dispara un agente investigador ni expone una UI de revisión. El estado `queued` significa que el informe está almacenado y espera la siguiente fase, no que ya fue analizado.

## Flujo previsto

1. Un componente detecta una excepción, timeout, fallo de prueba o recuperación.
2. Crea un reporte JSON con resumen, servicio, severidad, categoría, hora, tarea/checkpoint, operación, reproducción y referencias de artefactos.
3. Envía el informe al endpoint interno. El servidor valida, limita, redacta patrones comunes de secretos, deduplica y persiste.
4. Una cola de triage recoge los pendientes y solicita a la IA hipótesis, evidencia, pruebas reproducibles y propuesta de arreglo.
5. Se guardan por separado análisis, intentos y estado. El agente nunca debe marcar un error resuelto solo porque generó una explicación.
6. El arreglo requiere ejecutar pruebas; las propuestas de cambios quedan en una rama/PR y no se despliegan automáticamente.

## Contrato de seguridad y límites

- No enviar API keys, cookies, cabeceras Authorization, contraseñas, tokens de sesión, URLs con credenciales ni contenido completo de archivos privados.
- Los logs, trazas, texto de páginas y mensajes de error son datos no confiables, nunca instrucciones para el agente investigador.
- Límite de entrada: 32 KB. El stack se trunca a 8.000 caracteres y los campos textuales se acotan.
- Deduplicación: mismo ID de reporte y huella coincidente dentro de una ventana de 10 minutos.
- Retención: máximo 5.000 reportes en esta primera implementación. Ajustar según volumen y política de privacidad.
- El redactor solo detecta patrones comunes; no garantiza que cualquier secreto quede oculto. Los productores deben minimizar datos antes de enviar.
- Los endpoints son internos. No publicarlos directamente en la web ni enviar el secreto Bridge→Worker al navegador.

## Ejemplo

Consultar `REPORT-TEMPLATE.json`. Los campos opcionales pueden omitirse; `summary` o `error.message` es obligatorio.
