const RATE_HEADERS = [
  'retry-after',
  'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests',
  'x-ratelimit-limit-tokens', 'x-ratelimit-remaining-tokens', 'x-ratelimit-reset-tokens',
  'x-ratelimit-limit-requests-day', 'x-ratelimit-remaining-requests-day',
  'x-ratelimit-limit-tokens-day', 'x-ratelimit-remaining-tokens-day',
  'anthropic-ratelimit-requests-limit', 'anthropic-ratelimit-requests-remaining', 'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-limit', 'anthropic-ratelimit-tokens-remaining', 'anthropic-ratelimit-tokens-reset',
  'x-goog-quota-user'
];

function classifyProviderLimit(bodyText, status) {
  let message = '';
  let code = '';
  try {
    const parsed = JSON.parse(String(bodyText || ''));
    const error = parsed?.error || parsed;
    code = String(error?.code || error?.status || error?.type || '').slice(0, 100);
    message = String(error?.message || '').slice(0, 1000);
  } catch {}
  const source = (code + ' ' + message + ' ' + String(bodyText || '').slice(0, 2000)).toLowerCase();
  let category = status === 429 ? 'rate_limit_unspecified' : status === 413 ? 'request_too_large' : 'provider_transient';
  if (/tokens? per minute|tpm|input.*tokens?.*minute|itpm|output.*tokens?.*minute|otpm/.test(source)) category = 'tokens_per_minute';
  else if (/requests? per minute|rpm/.test(source)) category = 'requests_per_minute';
  else if (/requests? per day|rpd/.test(source)) category = 'requests_per_day';
  else if (/tokens? per day|tpd/.test(source)) category = 'tokens_per_day';
  else if (/quota.*exceed|resource_exhausted|billing|insufficient_quota|quota exceeded/.test(source)) category = 'quota_or_billing';
  else if (/context.length|maximum context|too many tokens|request too large|413/.test(source)) category = 'request_size_or_context';
  const numericLimits = [...String(message).matchAll(/\b(limit|requested|used|remaining|available)\s*[:=]?\s*([\d,]+)/gi)]
    .slice(0, 8).map(match => ({ field: match[1].toLowerCase(), value: Number(match[2].replace(/,/g, '')) }));
  const retryMatch = String(message).match(/retry(?:\s+in)?\s+(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?/i);
  return { category, providerCode: code || undefined, numericLimits, bodyRetryAfterMs: retryMatch ? Math.round(Number(retryMatch[1]) * 1000) : undefined };
}

export function logProviderRateLimitDiagnostic({ provider, model, status, response, bodyText, messages, maxTokens }) {
  const headers = {};
  for (const name of RATE_HEADERS) {
    const value = response?.headers?.get?.(name);
    if (value != null && String(value).length < 200) headers[name] = String(value);
  }
  const list = Array.isArray(messages) ? messages : [];
  const inputCharacters = list.reduce((sum, item) => sum + String(item?.content ?? '').length, 0);
  const toolCalls = list.reduce((sum, item) => sum + (Array.isArray(item?.tool_calls) ? item.tool_calls.length : 0), 0);
  const diagnostic = {
    provider: String(provider || 'unknown').slice(0, 80),
    model: String(model || 'unknown').slice(0, 160),
    status: Number(status) || 0,
    ...classifyProviderLimit(bodyText, status),
    request: {
      messageCount: list.length,
      inputCharacters,
      estimatedInputTokens: Math.ceil(inputCharacters / 2.5) + list.length * 8,
      requestedOutputTokens: Number(maxTokens) || null,
      toolCallCountInHistory: toolCalls
    },
    headers
  };
  // Intentionally never log prompts, message contents, raw provider bodies, or API credentials.
  console.warn('[worker][provider_rate_limit_diagnostic]', JSON.stringify(diagnostic));
}
