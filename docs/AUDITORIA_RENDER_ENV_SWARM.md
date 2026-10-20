# Auditoría de variables de Render para Multi Agent Swarm

El script `scripts/auditar_render_env_swarm.py` consulta variables de entorno de los servicios de Swarm mediante la API oficial de Render, en modo solo lectura.

## Ejecución recomendada desde GitHub Actions

1. En GitHub, abre **Settings → Secrets and variables → Actions** del repositorio.
2. Crea un **Repository secret** llamado `RENDER_API_KEY` con una API key de Render que tenga permisos suficientes para leer los servicios.
3. Abre **Actions → Auditoría de variables Render (solo lectura) → Run workflow**.
4. Al terminar, descarga el artefacto `swarm-render-env-audit`.

No añadas la API key al código, a un archivo `.env` versionado, a logs ni a los valores de configuración de los servicios de la aplicación. No la pegues en conversaciones.

## Alcance y seguridad

- Solo se hacen solicitudes HTTP GET; no se actualizan variables ni se despliega nada.
- El informe enumera variables esperadas, indica presencia/ausencia y compara en memoria algunos valores compartidos.
- No muestra valores secretos, tokens, hashes ni cadenas de conexión completas.
- Solo inspecciona variables directas de cada servicio; las variables heredadas de Render Environment Groups no aparecen en el endpoint por servicio y requieren una comprobación aparte.
- La API key debe tratarse como una credencial sensible. Usa una clave con el alcance mínimo disponible y revócala si se expone.
