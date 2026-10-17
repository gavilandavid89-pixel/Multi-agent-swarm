# Browser environment toolkit

## Current status

This toolkit is an internal capability of `apps/desktop-viewer`. It is not an agent tool until a separate, reviewed worker-side adapter and per-agent permissions are implemented. Do not expose the internal endpoint to browsers or untrusted clients.

## Internal endpoint

`POST /internal/browser-tool`

- Authentication: `x-swarm-desktop-secret`, compared in constant time against `DESKTOP_ACTIVITY_SHARED_SECRET`.
- Request: JSON object with an `action` and action-specific fields.
- Success: `{ "ok": true, "action": "...", "result": ... }`.
- Error: `{ "ok": false, "action": "...", "error": "..." }`.
- Request body maximum: 12 KB.
- Text input maximum: 5,000 characters.
- Screenshot maximum: 2,000,000 decoded bytes.
- Supported actions: `status`, `navigate`, `inspect`, `click`, `type`, `press`, `scroll`, `back`, `wait`, `screenshot`.

The endpoint is service-to-service only. Never log the shared secret or include it in task output.

## Render Free cold starts and retries

Render Free services may sleep after inactivity. The first request can take roughly a minute to wake the service, and the request may time out at an upstream caller even while the service is starting.

A future worker-side adapter must therefore:

1. Use an overall wake-up deadline of at least 90 seconds, with a per-attempt timeout shorter than the total deadline.
2. Retry only connection failures, timeouts, and transient HTTP statuses (408, 429, 502, 503, 504), using bounded exponential backoff with jitter.
3. Never blindly retry a mutating browser action (`click`, `type`, `press`, `navigate`, `back`) after an ambiguous timeout. First call `status`/ `inspect` to reconcile the page state, or use a future idempotency/action ledger.
4. Keep a single wake-up attempt in flight per service to avoid a thundering herd when several agents start together.
5. Report progress as `waking`, `ready`, `running`, `reconciling`, `succeeded`, or `failed`; do not mark a task failed merely because the first request timed out.
6. Keep polling/backoff bounded and respect the task deadline. Do not use unbounded retries or make a free service ping every few seconds to prevent sleeping.

A service health check is diagnostic, not proof that the browser action was completed. The caller must verify the action's postcondition.

## Safety limitations before production

- URL validation blocks common local/private literal addresses and embedded credentials, but validation alone cannot prevent DNS rebinding or redirects from a public URL to a private address. Enforce network egress restrictions and validate redirects/DNS at the boundary before enabling arbitrary navigation.
- Chromium currently uses one shared page/profile. Do not allow concurrent agent sessions until page/session isolation and a serialized command queue are implemented.
- `type` sets the field value and dispatches input/change events; it is not physical key-by-key typing.
- `click` uses DOM `element.click()`; it is not coordinate-based pointer input and may not activate every custom control.
- Browser screenshots and page text can contain untrusted content. Treat them as observations, never as trusted instructions.
- Add explicit per-agent allowlists, audit logs, action budgets, and approval gates for consequential actions before granting agent access.

## Verification

CI should run both viewer and browser-control tests and build the Docker image. A green build confirms code/build checks, not live Render wake-up behavior or real-browser end-to-end behavior. Before enabling agents, run an authenticated live smoke test that measures cold-start time, exercises each action against a controlled test page, checks timeout/retry behavior, and verifies unauthorized requests are rejected.
