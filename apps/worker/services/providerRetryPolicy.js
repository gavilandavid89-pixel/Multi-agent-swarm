const MAX_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function retryDelayFromBody(bodyText) {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText);
    const details = Array.isArray(parsed?.error?.details) ? parsed.error.details : [];
    for (const detail of details) {
      const raw = detail?.retryDelay || detail?.retry_delay;
      if (typeof raw === 'string') {
        const match = raw.match(/^(\d+(?:\.\d+)?)s$/i);
        if (match) return Number(match[1]) * 1000;
      }
    }
    const message = String(parsed?.error?.message || '');
    const match = message.match(/retry(?:\s+in)?\s+(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?/i);
    if (match) return Number(match[1]) * 1000;
  } catch {}
  const match = String(bodyText).match(/retry(?:\s+in)?\s+(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?/i);
  return match ? Number(match[1]) * 1000 : null;
}

export function getProviderRetryDelayMs({ retry = 1, retryAfter, bodyText = '', baseMs = 3000, random = Math.random } = {}) {
  const numericRetryAfter = Number(retryAfter);
  if (Number.isFinite(numericRetryAfter) && numericRetryAfter > 0) {
    return Math.max(250, Math.min(MAX_RETRY_AFTER_MS, Math.round(numericRetryAfter * 1000)));
  }
  const dateRetryAfter = Date.parse(String(retryAfter || ''));
  if (Number.isFinite(dateRetryAfter)) {
    return Math.max(250, Math.min(MAX_RETRY_AFTER_MS, dateRetryAfter - Date.now()));
  }
  const providerHint = retryDelayFromBody(bodyText);
  if (Number.isFinite(providerHint) && providerHint > 0) {
    return Math.max(250, Math.min(MAX_RETRY_AFTER_MS, Math.round(providerHint)));
  }
  const safeBase = Number.isFinite(baseMs) ? Math.min(60000, Math.max(250, baseMs)) : 3000;
  const exponential = Math.min(safeBase * (2 ** Math.min(Math.max(0, retry - 1), 8)), 900000);
  const jitter = 0.8 + Math.max(0, Math.min(1, Number(random()) || 0)) * 0.4;
  return Math.max(250, Math.round(exponential * jitter));
}

export function getDeferredCooldownMs(retryAfterMs, failureStreak, { baseMs = 30000, maxMs = 1800000 } = {}) {
  const streak = Math.max(1, Math.min(20, Number(failureStreak) || 1));
  const base = Number.isFinite(baseMs) ? Math.max(1000, baseMs) : 30000;
  const cap = Number.isFinite(maxMs) ? Math.max(base, maxMs) : 1800000;
  const exponential = Math.min(base * (2 ** Math.min(streak - 1, 10)), cap);
  const providerDelay = Math.max(0, Number(retryAfterMs) || 0);
  return Math.max(1000, Math.min(cap, Math.max(providerDelay, exponential)));
}

/**
 * Returns the remaining scheduled delay for queued jobs.
 * This guards against another worker's lock-busy poll bypassing a provider cooldown.
 */
export function getScheduledJobDelayMs({ status, retryAt, now = Date.now() } = {}) {
  if (status !== 'queued' || !retryAt) return 0;
  const dueAt = Date.parse(String(retryAt));
  if (!Number.isFinite(dueAt)) return 0;
  return Math.max(0, dueAt - Number(now));
}
