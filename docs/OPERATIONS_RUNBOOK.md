# Guía de operaciones — Multi-agent Swarm

**Última revisión de esta guía:** 2026-10-18  
**Alcance:** procedimientos conservadores para GitHub, Render y Neon. Esta guía no afirma que una verificación pendiente haya sido ejecutada.

## 1. Reglas antes de tocar producción

1. No cambiar `DATABASE_URL`, `SWARM_DATABASE_URL`, claves de cifrado ni secretos como parte de una corrección rutinaria.
2. Antes de migrar, renombrar, vaciar o borrar una base: confirmar el destino desde la aplicación, hacer un backup/export verificable y ensayar restauración o lectura de la copia.
3. Nunca copiar secretos, connection strings completas, tokens, cookies ni cabeceras de autorización a GitHub Issues, commits, informes o logs.
4. Mantener cambios en una rama y abrir un PR. Revisar CI y diff antes de fusionar.
5. Separar evidencia de hipótesis. Un deploy exitoso solo confirma que Render aceptó/ejecutó el despliegue, no que el usuario pueda completar el flujo de punta a punta.
6. No habilitar ejecución de código arbitrario con red o secretos de producción sin aislamiento y control de egress aplicados fuera del proceso Node.

## 2. Inventario observado en la auditoría

Los datos de esta sección son una fotografía de la revisión de octubre de 2026; confirmar en los dashboards antes de actuar.

| Componente | Identidad/ubicación observada | Estado y precaución |
|---|---|---|
| Bridge | `swarm-bridge`, `https://swarm-bridge.onrender.com` | Comprobar `/readyz` y confirmar que `WORKER_BASE_URL` apunta al Worker correcto. |
| Worker | `swarm-worker`, `https://swarm-worker-fgnz.onrender.com` | Comprobar `/readyz`, logs recientes y persistencia; no inferir salud actual de logs antiguos. |
| PostgreSQL de tareas del Worker | Render `comite-database`, base `comite_database` | Su esquema observado corresponde a tareas/idempotencia. No cambiar ni borrar solo por el nombre. |
| Cuentas y claves de proveedores | Neon, proyecto `multi-agent-swarm`, rama `production`, base `swarm` | Confirmar que Bridge y Worker usan la misma rama/base y la misma clave de cifrado de APIs. |
| Historial Neon | Base `swarm_history` | En la revisión no aparecían tablas de usuario; no asumir que sea la base activa de tareas. |
| Visor de escritorio | Servicios de visor creados por separado en Render | No asumir que está integrado con producción. Revisar rama, Dockerfile, variables y auth de extremo a extremo. |

### Aviso de retención de la base de Render

En la revisión se observó que el plan Free de `comite-database` indicaba vencimiento el **12 de noviembre de 2026**. Confirmá el aviso vigente en el dashboard de Render: [abrir base de datos](https://dashboard.render.com/d/dpg-db7b6mo473hc73cnb9u0-a).

**Acción prioritaria:** revisar las opciones de backup/export y el límite de retención. No ejecutar una migración a Neon por intuición. Antes de migrar, comparar esquema, conteos y comportamiento del Worker; después validar restauración y una prueba de lectura/escritura inocua. Conservar la base de origen hasta que la migración haya sido validada y exista un plan de rollback.

## 3. Comprobación de salud

Ejecutar en el dashboard o desde un entorno autorizado:

- `GET /healthz`: proceso vivo; no demuestra que PostgreSQL o dependencias estén listas.
- `GET /readyz`: readiness declarada por el servicio; debe devolver HTTP 200 cuando esté listo y 503 cuando no.
- Revisar logs recientes por ventana temporal y correlacionarlos con el ID de tarea, intento y checkpoint.
- Para una comprobación E2E, usar una tarea mínima e inocua y confirmar: creación, ejecución, persistencia, lectura de resultado y ausencia de duplicados. La prueba puede consumir tokens si llama a proveedores reales.
- No reintentar a ciegas operaciones POST que no sean idempotentes.

El archivo `render.yaml` declara `/readyz`, pero el estado efectivo del dashboard debe comprobarse por separado; una definición en el repositorio no demuestra que Render la haya aplicado.

## 4. Diagnóstico de proveedor de IA

Clasificar antes de cambiar código:

- `model_not_found` / HTTP 404: verificar ID de modelo y disponibilidad del proveedor; no repetir indefinidamente el mismo modelo.
- HTTP 413 o límite TPM: reducir concurrencia/salida, revisar límites de cuenta y activar fallback configurado si corresponde.
- Respuesta vacía o JSON incompleto: registrar proveedor/modelo, etapa, intento y tipo de error; limitar reintentos y validar la salida antes de aceptarla.
- Error de red o 5xx: usar backoff y fallback configurado; no dar por garantizado el failover sin observar el intento alternativo.
- Error durante apagado: distinguir el cierre esperado de conexiones del fallo original. Evitar que el shutdown cierre dos veces un mismo pool.

Los logs del 12–15 de octubre de 2026 registraron ejemplos de 404 `model_not_found`, 413 por límite TPM, respuestas vacías/JSON incompleto y un cierre duplicado de pool durante apagado. Son antecedentes históricos, no prueba de que esos errores continúen ocurriendo.

## 5. Visor de escritorio y runner

- El visor debe tener su propia autenticación; los tickets SSO deben ser efímeros, de un solo uso y protegidos contra replay.
- Verificar que la versión del Bridge desplegada exponga el endpoint que consume el visor. En la auditoría, `/internal/desktop-activity` existía en una rama de feature pero no en `main`; la integración depende de alinear y desplegar versiones compatibles.
- Revisar contexto de Docker y ruta del Dockerfile contra la configuración efectiva de Render. Un deploy fallido anterior de un visor reportó que no encontraba `Dockerfile`; no darlo por arreglado sin un build correcto.
- Chromium + Xvfb sirve para pruebas de navegador, pero no constituye un IDE persistente ni un runner multi-lenguaje aislado.
- Mantener deshabilitada la ejecución arbitraria hasta que el runner separado tenga autenticación, límites de CPU/memoria/procesos/disco/tiempo, limpieza de workspace, artefactos acotados y política de red aplicada a nivel de infraestructura.

## 6. Flujo de cambios recomendado

1. Crear rama corta desde `main`.
2. Hacer un cambio acotado y añadir una prueba de regresión.
3. Ejecutar `npm run check` localmente y CI.
4. Revisar logs/build; no confundir tests unitarios con E2E de producción.
5. Abrir PR con alcance, pruebas ejecutadas, riesgos y pasos de rollback.
6. Fusionar solo tras revisar el diff y los checks.
7. Desplegar por separado y verificar health/readiness y una tarea de humo.
8. Registrar resultado y enlaces a logs/run en el informe de diagnóstico, sin secretos.

## 7. Checklist para cerrar un incidente

- [ ] Fecha/hora y zona horaria documentadas.
- [ ] Servicio, release/commit y ambiente identificados.
- [ ] ID de tarea/checkpoint correlacionados, si existen.
- [ ] Error original conservado, con secretos redactados.
- [ ] Hipótesis separadas de hechos observados.
- [ ] Reproducción mínima o explicación de por qué no fue posible.
- [ ] Cambio propuesto con prueba de regresión.
- [ ] CI y validación post-despliegue registrados.
- [ ] Rollback y estado de persistencia comprobados.
- [ ] Incidente marcado como resuelto solo tras verificar el resultado.
