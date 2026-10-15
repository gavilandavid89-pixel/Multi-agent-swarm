# Puerta de integridad de entregables

## Qué hace
Antes de marcar una tarea como completada, el worker pasa la entrega por controles deterministas además de la revisión del agente validador. Esta puerta bloquea contenido vacío, marcadores explícitos de truncamiento, fences Markdown sin cerrar, secciones de archivo incompletas y JSON inválido cuando el objetivo pide JSON.

## Qué no afirma
Superar esta puerta no prueba que el código funcione en ejecución, que una web se haya desplegado, ni que un archivo binario exista. La sintaxis y los chequeos estáticos siguen siendo controles separados; ejecutar código generado requiere un runner aislado, no el worker que contiene credenciales y acceso a la base de datos.

## Comportamiento de fallo
Los hallazgos se agregan a los del validador y fuerzan el veredicto a `NEEDS_CHANGES`. El flujo existente puede intentar correcciones acotadas; si no consigue aprobar todos los controles en las rondas configuradas, la tarea queda en `needs_review`, no como completada.

## Límites
- La detección de JSON se activa cuando el objetivo lo solicita explícitamente.
- Es una barrera de integridad, no un validador universal de esquemas ni una garantía semántica.
- No ejecuta herramientas ni código generado y no añade llamadas de proveedor.
