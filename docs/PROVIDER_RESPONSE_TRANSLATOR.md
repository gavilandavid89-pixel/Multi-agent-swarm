# Traductor de respuestas de proveedores

## Objetivo

Las respuestas de proveedores se traducen a un contrato interno versionado antes de que el motor de tareas las consuma. El traductor es código determinista; no se llama a otro modelo por cada respuesta. Un agente de recuperación puede proponerse más adelante para diagnosticar formatos desconocidos, pero no debe validar ni ejecutar por sí solo una respuesta no confiable.

## Contrato canónico v1

```json
{
  "schemaVersion": 1,
  "status": "success",
  "provider": "Anthropic",
  "model": "model-id",
  "content": "Texto extraído",
  "toolCalls": [],
  "usage": {
    "inputTokens": 12,
    "outputTokens": 7,
    "totalTokens": 19
  },
  "finishReason": "stop",
  "warnings": []
}
```

- `status`: `success`, `blocked` o `error`.
- `finishReason`: normaliza razones conocidas a `stop`, `length`, `content_filter` o `tool_calls`; razones desconocidas se conservan para diagnóstico.
- `usage`: los contadores desconocidos son `null`, no se inventan.
- `toolCalls`: se preservan para no perder información. El worker actual no ejecuta llamadas a herramientas; si una respuesta requiere ejecutarlas, la petición se rechaza de forma segura y se intenta el failover configurado.
- `warnings`: códigos breves, nunca cuerpos completos ni credenciales.

## Formatos soportados

- OpenAI Chat Completions y formatos compatibles: `choices[].message`, contenido fragmentado, rechazo y uso de tokens.
- OpenAI Responses API: `output_text`, `output[].content[]`, estado incompleto y llamadas a funciones.
- Anthropic Messages API: bloques de texto, razón de finalización, uso de tokens y bloques `tool_use`.
- Gemini: `candidates[].content.parts[]`, `usageMetadata` y bloqueos de `promptFeedback`.
- Algunos proveedores personalizados que devuelven texto en `response` o `result`.

La compatibilidad de respuesta no implica que cualquier URL personalizada tenga una API de solicitudes compatible. El endpoint nativo de Anthropic se selecciona únicamente cuando el host es exactamente `api.anthropic.com`; los demás proveedores personalizados deben exponer el contrato OpenAI-compatible usado por el motor.

## Manejo de formatos desconocidos

1. JSON inválido, una estructura desconocida o un resultado vacío no se presenta como una respuesta correcta.
2. Se emite un diagnóstico limitado (proveedor, modelo, código y longitud del cuerpo), sin registrar el cuerpo ni claves.
3. El motor aplica reintentos acotados y failover según la política existente, conservando el checkpoint de la tarea.
4. La traducción no demuestra que el contenido sea correcto: el validador de resultados/archivos debe comprobarlo por separado.
5. Las respuestas del proveedor se tratan como datos no confiables. El traductor no ejecuta código, herramientas ni instrucciones contenidas en el cuerpo.

## Pruebas

`tests/providerResponse.test.mjs` cubre normalización del contrato, uso de tokens, truncamiento, bloqueos, llamadas a herramientas y formatos desconocidos. `tests/providerFailover.test.mjs` prueba el adaptador nativo de Anthropic y el failover después de una respuesta incompatible.
