# Swarm live desktop viewer

This service runs a dedicated Chromium desktop inside Xvfb and serves a noVNC view through an HTTP authentication gate. It is a viewer prototype, separate from the agent runner: it does **not** execute user-supplied shell commands or connect to the worker automatically.

## Required Render configuration

- Runtime: Docker
- Dockerfile: `apps/desktop-viewer/Dockerfile`
- Docker context: repository root
- `VIEWER_USERNAME`: non-empty viewer login
- `VIEWER_PASSWORD`: a unique random secret of at least 24 characters
- `PORT`: set by Render; default 3300 for local use

Never commit the password or publish it in logs. Render terminates HTTPS at the public edge. The application protects the viewer page and WebSocket upgrade with HTTP Basic authentication. `/healthz` is intentionally unauthenticated and reveals only a generic readiness state.

## Endpoints

- `GET /healthz`: minimal health response.
- `GET /`: noVNC browser UI, requires authentication.
- `GET /websockify` WebSocket upgrade: authenticated desktop stream.

## Security limits

- The VNC server binds to loopback only and has no VNC password because it is not directly exposed; the public gateway requires HTTP Basic authentication.
- The viewer is a public web service. Use a long unique password and do not share its URL or credentials.
- Chromium is started without `--no-sandbox` only if the container environment itself supports its sandbox; the current image does not grant extra capabilities. Verify the desktop process starts successfully in Render logs before relying on it.
- This prototype displays a clean Chromium desktop; it does not yet stream worker task state or allow agents to control this browser.
- Before connecting agent workloads, implement per-session isolation, network egress restrictions, resource limits, and a short-lived authenticated session/token model. Do not use this viewer as a security sandbox.
