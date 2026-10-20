/**
 * Choose the narrowest safe retry path from persisted task state.
 * Runner infrastructure failures should not force fresh LLM validation calls.
 */
export function getRetryRecoveryMode(payload = {}) {
  if (
    payload.lastCheckpoint === 'runner-infra-error' &&
    typeof payload.delivery === 'string' && payload.delivery.length > 0 &&
    payload.validation && typeof payload.validation === 'object' &&
    payload.syntax?.runnerExecution?.infraError === true
  ) {
    return 'runner-only';
  }
  return 'workflow';
}
