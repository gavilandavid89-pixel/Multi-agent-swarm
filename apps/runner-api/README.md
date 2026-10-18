# Swarm Runner API (experimental)

This service is the authenticated control plane for short-lived, isolated code-execution containers. It is **not** part of the public bridge and must never be exposed to browsers or agents directly. Only the Worker may call it.

## Deployment boundary

Run this API on a dedicated execution host with Node.js 22 and a Docker daemon, or on an equivalent isolated runner host. It must not share the Worker host, production database credentials, provider API keys, or other secrets. The API process needs Docker access; treat that host as a dedicated security boundary. Configure a rootless Docker daemon for the dedicated service account rather than granting it access to a root-owned Docker socket; if rootful Docker is unavoidable, assume the API process is effectively host-root. Prefer a host firewall, and keep the Docker socket unavailable to job containers.

Render's normal web container is not assumed to have a usable Docker daemon or permission to start sibling containers. Do not add this service to Render or enable Worker integration until a separate runner host has passed the smoke tests. The existing Render Free services remain unchanged.

## Start

```sh
sudo useradd --system --create-home --home-dir /var/lib/swarm-runner --shell /usr/sbin/nologin swarm-runner
sudo install -d -o swarm-runner -g swarm-runner -m 0700 /var/lib/swarm-runner
cd apps/runner-api
cp .env.example .env
# Set RUNNER_SHARED_SECRET to a fresh 32+ character random secret, never commit it.
node server.js
```

Set `RUNNER_SHARED_SECRET` to the exact same random secret configured as `AGENT_RUNNER_SHARED_SECRET` on the Worker; it must be different from `WORKER_SHARED_SECRET`. Keep the API reachable only over a private network/firewall rule from the Worker.

The host must already have `swarm-agent-runner:local` built from `apps/runner/Dockerfile`. Use a process supervisor (systemd or equivalent) to restart the API and restrict its inbound port to the Worker using a private network/firewall. Do not publish port 3200 to the public Internet.

## API contract

Every `/v1/*` request requires `x-swarm-runner-secret`. Use `x-swarm-idempotency-key` on job creation to make retries safe.

- `POST /v1/jobs`: `{ "files": [{"path":"main.py","content":"print(1)"}], "command":["python3","main.py"], "network":"none", "timeoutMs":60000, "workspaceId":"<uuid>", "resetWorkspace":true }`. Returns HTTP 202 and a job ID. Omit `workspaceId` for an isolated one-shot workspace.
- Sequential tool calls can reuse the same task-scoped `workspaceId`: after a completed job, send `files: []` and `resetWorkspace: false` to continue from its filesystem. The API rejects concurrent jobs for the same workspace. Each job receives a new container and a fresh tmpfs; use `network:"restricted"` only for a dependency-preparation command, then submit a separate job with `network:"none"` for tests.
- `GET /v1/jobs/:id`: poll `queued`, `running`, `succeeded`, `failed`, `timed_out`, or `cancelled`; output is bounded.
- `GET /v1/jobs/:id/files`: read the immutable, bounded file snapshot captured when that job completed, including generated artifacts. Dependency directories such as `node_modules` are kept in the task workspace for sequential jobs but omitted from the returned artifact snapshot.
- `POST /v1/jobs/:id/cancel`: cancel queued/running work.

Limits: 200 files, 2 MiB total input, 256 KiB per file, 1–32 argv items, 1–120 seconds wall clock per job, 1 GiB RAM, 2 CPUs, 128 PIDs, 256 MiB workspace tmpfs, 64 KiB each stdout/stderr, a queue cap, at most 20 retained results and a 24-hour TTL. The API passes arguments directly to Docker; it does not invoke a host shell or forward host environment variables.

## Network modes

- `none` is the default for all code execution.
- `restricted` is only for dependency preparation. It requires `swarm-agent-egress` to be a Docker internal network and a healthy `swarm-egress-proxy`. The sandbox receives a fixed proxy address and no normal DNS resolver. The proxy allowlist lives in `apps/runner/egress-proxy/allowed-domains.txt`.
- Never provide secrets to the sandbox. Dependency install hooks execute project code; prefer lockfiles and script-disabled installs where possible, then rerun tests with network disabled.

The proxy is not a substitute for host-level egress/DNS enforcement against hostile code. Use a dedicated host, host firewall, restricted DNS, and preferably rootless Docker or a stronger VM/microVM boundary for multi-tenant untrusted workloads.

## Agent tool protocol

The Worker is the trusted orchestrator. An agent can request an execution tool through the Worker, but cannot choose the image, Docker flags, environment variables, host mounts, secrets, network policy, or resource limits. The Worker validates the tool request, submits an argv array plus a bounded set of project files with an idempotency key, polls the job, and returns only bounded logs/artifacts to the requesting agent. Execution is asynchronous so a cold start or slow build does not lose the task checkpoint. Never let an agent call this API with a browser credential or an unrestricted shared secret.
