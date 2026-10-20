# Runner and Worker recovery validation runbook

This runbook separates three guarantees that must not be conflated:

1. Runner API/container recovery after process or Docker daemon interruption.
2. Recovery of the Worker orchestration journal/checkpoints after a Worker process restart.
3. A real machine reboot with persistent storage and service auto-start.

GitHub Actions can test the first two in CI only to the extent explicitly described by each test. It cannot prove a full host reboot because that would terminate the hosted runner itself.

## Safety boundary

- Keep `AGENT_RUNNER_BASE_URL`, `AGENT_RUNNER_SHARED_SECRET`, and `AGENT_RUNNER_REQUIRED` absent from the production Render blueprint until a dedicated private runner host has passed this runbook.
- Keep `AGENT_RUNNER_REQUIRED` unset or `false` during staging setup. Do not turn it on as a diagnostic shortcut.
- Do not expose port 3200 publicly, bind to `0.0.0.0`, reuse Worker/provider credentials on the runner host, or mount the Docker socket into job containers.
- Use a dedicated non-production Worker/database and a dedicated VM for these tests. Do not use production tasks as test fixtures.
- Do not merge or deploy the runner as part of this runbook.

## 1. Provisioning prerequisites for a real VM reboot test

Use a dedicated Linux VM with a persistent disk, private connectivity to the staging Worker, a host firewall, Node.js 22, Docker Engine with rootless mode preferred, and a service supervisor. Build `swarm-agent-runner:local` from `apps/runner/Dockerfile` on that host. Configure `RUNNER_STATE_DIR=/var/lib/swarm-runner` on the persistent disk and ensure only the runner service account can access the state directory and its environment file.

Before testing, record (without secrets):
- VM identifier and OS image/version.
- Persistent disk/mount identity and mount point.
- Runner API commit SHA and runner image digest.
- systemd unit name and enabled state.
- Private interface/firewall source rule for the staging Worker.
- Confirmation that no public inbound rule exists for TCP/3200.

### systemd service requirements

The unit must:
- run as the dedicated `swarm-runner` account;
- start only after the persistent state mount and rootless Docker socket are available;
- use an environment file readable only by that account;
- restart on process failure;
- use a private bind address only;
- never print the shared secret in logs;
- have `WantedBy=multi-user.target` and be enabled.

Do not copy a generic unit blindly: rootless Docker socket paths vary by host. Verify the actual `XDG_RUNTIME_DIR` and `DOCKER_HOST` for the service account before enabling it.

## 2. Runner test matrix: process restart, daemon restart, real reboot

Use a unique test run ID and store the test evidence outside the VM or on a separate secure system. Do not store secrets or submitted source containing credentials.

### A. Baseline and persistence sentinel

1. Confirm `systemctl is-enabled swarm-runner-api` reports `enabled`.
2. Confirm `systemctl is-active swarm-runner-api` reports `active`.
3. Confirm authenticated/private `/readyz` returns `ok=true`, `docker=ready`, and `image=ready`.
4. Submit one short successful job and record its job ID and idempotency key.
5. Confirm the job reaches `succeeded`; record a non-sensitive artifact hash.
6. Verify the state directory and the job's persisted state are on the intended persistent mount.

### B. API process restart

1. Submit one long-running test job and wait until the container is actually running (do not rely only on API status `running`).
2. Abruptly terminate only the API process, then let systemd restart it.
3. Verify readiness returns without manual intervention.
4. Verify the interrupted active job fails closed; it must not be silently marked successful or resume arbitrary code.
5. Verify the previously completed job, artifact hash, and idempotency record remain available after restart.
6. Retry the interrupted operation only with the documented explicit idempotent retry path.

### C. Docker daemon restart

Repeat the active-job and completed-job checks around a controlled Docker daemon restart during a maintenance window. The API must recover readiness, interrupted work must fail closed, and completed state/artifacts must survive.

### D. Real VM shutdown/boot (the missing physical test)

1. Ensure the VM console/recovery path is available and the maintenance window is approved.
2. Verify the persistent disk is mounted and the runner service is enabled.
3. Create a completed sentinel job and record its job ID, idempotency key, and artifact hash.
4. Start a second long-running job; confirm its container is running.
5. Shut down/reboot the entire VM using the cloud provider's normal reboot action (not a process kill and not a Docker restart).
6. After boot, do not manually start the service. Verify the disk mounted, Docker/rootless socket became available, systemd started the API, and `/readyz` became healthy within the agreed startup budget.
7. Verify the completed sentinel's state, idempotency record, and artifact hash match exactly.
8. Verify the active job interrupted by the reboot is failed closed and does not execute again automatically.
9. Submit a new idempotent retry for that failed operation and verify it runs exactly once.
10. Repeat the full reboot test at least twice; record timestamps, service logs, readiness timings, and results.

**Pass criteria:** all expected persistence and fail-closed assertions pass after both reboot attempts, with no manual service start, no duplicate execution, no public listener, and no secret leakage. Any mismatch blocks integration.

## 3. Separate Worker restart verification

Run this against a staging Worker and a dedicated test database only. This verifies the orchestration journal and checkpoint behavior, not a physical runner host reboot.

For each case, capture the task ID, stage/checkpoint, runner job ID, idempotency key fingerprint (never the key itself), and final artifact/result hash.

1. **Before remote submission:** stop/restart the Worker after the durable journal entry is written but before the request is sent. After restart, verify the same invocation is reconciled safely and no duplicate runner job is created.
2. **Ambiguous transport failure:** interrupt the Worker/network after request transmission but before the response is persisted. After restart, verify the same idempotency key is reused and the existing job/result is reconciled.
3. **After runner completion, before Worker checkpoint:** restart the Worker after the runner reports completion but before the result checkpoint is committed. Verify the completed result is recovered rather than executed again.
4. **Terminal runner infrastructure failure:** verify a failed terminal infrastructure attempt rotates to a new idempotency key for the next explicit attempt, while ambiguous transport failures do not rotate it.
5. **Changed workspace:** change the workspace content between attempts and verify the journal does not reuse a key bound to a different workspace hash.
6. **Runner-only retry:** when delivery and AI validation are already checkpointed and only the runner failed due to infrastructure, verify recovery resumes at `runner-only` and does not repeat the completed AI delivery/validation steps.
7. **Non-infrastructure failure:** a real code/test failure must not be mislabeled as infrastructure and must follow the normal correction path.

**Pass criteria:** each recovered invocation has one logical effect, completed checkpoints remain intact, no credential is logged, and a Worker restart does not silently mark a missing or incomplete runner result as success.

## 4. Production integration gate

Do not enable remote runner integration until all are true:

- [ ] Dedicated host/VM is isolated from Worker/provider secrets and other services.
- [ ] Private network and firewall allow only the intended Worker source; port 3200 is not public.
- [ ] Host-level egress/DNS controls are in place in addition to the sandbox proxy.
- [ ] Rootless Docker or a documented stronger VM/microVM boundary is used.
- [ ] Runner process restart, Docker restart, and two real VM reboot tests pass.
- [ ] Worker restart cases above pass in staging.
- [ ] Logs and artifacts have been checked for secret leakage.
- [ ] The exact tested commit and image digest are recorded.
- [ ] A separate explicit change review authorizes configuration; do not silently add runner variables to `render.yaml`.

Until then, leave the Worker integration optional and the Render blueprint unchanged.
