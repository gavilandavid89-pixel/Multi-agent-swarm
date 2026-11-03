# Version-aware peer review queue (feature branch)

This module is the first implementation slice for agent-to-agent delivery review and correction routing. It is intentionally isolated from live task execution while the state transitions are validated.

## Flow
1. Author submits a delivery. Content is immutable per version; the head pointer names the newest version.
2. A different role reviews the exact version/hash. Peer approval moves it only to `ready_for_supervisor`, never directly to `approved`.
3. A correction finding creates a version-bound queue item assigned to the original author. Queue items do not preempt a busy author.
4. When the author is idle, the next queued correction can be claimed. Before claiming, the queue verifies the target is still the current version and the content hash matches.
5. Findings against an old version are retained as `needs_revalidation`, not blindly applied to the latest version.
6. A corrected delivery must point to the exact predecessor and preserve the original artifact/version history.

## State location
The functions are pure transformations over the existing persisted job payload shape, suitable for storage through the worker's existing payload persistence. The runtime tool wiring and end-to-end worker test are deliberately separate follow-up work; this branch does not yet change live agent behavior.

## Test
`node --test services/agentReviewQueue.test.js`

No provider API calls are made by these tests.

## History retention safeguards

- Current artifact-head versions are preserved even when the nominal history budget is exceeded; the head map must never point to a version that was silently evicted.
- When queue history is trimmed, terminal correction entries are discarded first. Queued, in-progress, and needs-revalidation work is retained even if that means exceeding the nominal queue-history cap.
- These safeguards prevent memory-oriented caps from silently deleting live pointers or unfinished work. They do not replace durable database transactions or multi-worker concurrency controls; those must be covered by the runtime integration.
