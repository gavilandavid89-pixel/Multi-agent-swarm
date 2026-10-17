# Swarm live desktop viewer

This service runs a dedicated Chromium desktop inside Xvfb and serves a noVNC view through an HTTP authentication gate. It is a viewer prototype, separate from the agent runner: it does **not** execute user-supplied shell commands or connect to the worker automatically.

## Required Render configuration

- Runtime: Docker
- Root Directory / build context: `apps/desktop-viewer`
- Dockerfile path relative to that root: `Dockerfile`
- `DESKTOP_VIEWER_TICKET_SECRET`: random secret of at least 32 characters; configure the identical value in Bridge and viewer to enable admin SSO
- `VIEWER_ADMIN_USERNAME`: optional standalone admin login only when Bridge SSO is not configured
- `VIEWER_ADMIN_PASSWORD`: optional standalone password of at least 24 characters only when Bridge SSO is not configured
- `PORT`: set by Render; default 3300 for local use

Never commit the password or publish it in logs. Render terminates HTTPS at the public edge. With `DESKTOP_VIEWER_TICKET_SECRET` and Bridge `DESKTOP_VIEWER_URL` configured, the main app's Bridge validates the existing Bearer session and requires the real `admin` role before issuing a signed 30-second launch ticket. The viewer exchanges it for an hour-long HttpOnly, Secure, SameSite=Strict cookie, which protects both page and WebSocket access. In SSO mode, standalone Basic auth cannot bypass the Bridge role check. `/healthz` is intentionally unauthenticated and reveals only a generic readiness state.

## Endpoints

- `GET /healthz`: minimal health response.
- `GET /`: noVNC browser UI, requires authentication.
- `GET /websockify` WebSocket upgrade: authenticated desktop stream.

## Security limits

- The VNC server binds to loopback only and has no VNC password because it is not directly exposed; the public gateway requires HTTP Basic authentication.
- The viewer endpoint is public but the page and WebSocket are protected by the signed admin cookie. Configure `DESKTOP_VIEWER_TICKET_SECRET` identically on Bridge and viewer and set Bridge's `DESKTOP_VIEWER_URL` to the viewer's public HTTPS origin. Never pass the long-lived Bridge Bearer token in a URL. Standalone Basic auth is only a fallback when SSO is not configured.
- Chromium is started without `--no-sandbox` only if the container environment itself supports its sandbox; the current image does not grant extra capabilities. Verify the desktop process starts successfully in Render logs before relying on it.
- This prototype displays a clean Chromium desktop; it does not yet stream worker task state or allow agents to control this browser.
- Before connecting agent workloads, implement per-session isolation, network egress restrictions, resource limits, and a short-lived authenticated session/token model. Do not use this viewer as a security sandbox.
