# Version-aware peer review queue (feature branch)

This module is the first integrated slice of agent-to-agent delivery review and correction routing. Agents now receive submit/review/lineage tools through the live dispatcher, and mutations are persisted through a PostgreSQL row-locked payload transform. This is not yet the complete idle-agent scheduling loop or full system-wide coordination rollout.

## Flow
1. Author submits a delivery. Content is immutable per version; the head pointer names the newest version.
2. A different role reviews the exact version/hash. Peer approval moves it only to `ready_for_supervisor`, never directly to `approved`.
3. A correction finding creates a version-bound queue item assigned to the original author. Queue items do not preempt a busy author.
4. When the author is idle, the next queued correction can be claimed. Before claiming, the queue verifies the target is still the current version and the content hash matches.
5. Findings against an old version are retained as `needs_revalidation`, not blindly applied to the latest version.
6. A corrected delivery must point to the exact predecessor and preserve the original artifact/version history.

## State location
The state transitions remain pure transformations over the encrypted job payload. Live tool adapters persist submissions and reviews through `mutateJobPayload`, which locks the job row with `SELECT ... FOR UPDATE` so concurrent agents cannot silently overwrite each other's artifact/review updates. The store also exposes `claimAgentCorrectionForJob`, using a transaction and the same row lock to prevent two workers claiming the same correction. The automatic scheduler that prioritizes a correction when its author becomes idle, and the full end-to-end worker flow, remain follow-up work.

## Test
`node --test services/agentReviewQueue.test.js`

No provider API calls are made by these tests.

## History retention safeguards

- Current artifact-head versions are preserved even when the nominal history budget is exceeded; the head map must never point to a version that was silently evicted.
- When queue history is trimmed, terminal correction entries are discarded first. Queued, in-progress, and needs-revalidation work is retained even if that means exceeding the nominal queue-history cap.
- These safeguards prevent memory-oriented caps from silently deleting live pointers or unfinished work. They do not replace durable database transactions or multi-worker concurrency controls; those must be covered by the runtime integration.


## Current integration boundary

- Integrated: submit immutable artifact versions; review an exact version; record verdict/evidence; queue corrections to the original author; inspect lineage without returning raw artifact content; transactional payload mutation; transactional correction claiming API; tool permissions for all agent roles; prompt instructions for version-bound review.
- Tested without provider API calls: queue state transitions and dispatcher routing/permissions. `npm run check` now includes these tests.
- Not yet complete: automatically wake/assign corrections when the original author becomes idle; universal shared event bus and task dependency planner; provider quota/capacity reservations; full review/repair/supervisor end-to-end test; admin observability UI. These remain explicit subsequent implementation stages, not claims of completion.
