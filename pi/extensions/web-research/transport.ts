export type ProviderName = "tavily" | "exa";
export type ErrorKind =
  | "authentication"
  | "payment_or_quota"
  | "permission"
  | "validation"
  | "safety-policy"
  | "rate_limit"
  | "timeout"
  | "not_found"
  | "upstream"
  | "cancelled"
  | "unknown";

export class WebProviderError extends Error {
  readonly provider: ProviderName;
  readonly kind: ErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly retryCount: number;
  details: Record<string, unknown>;

  constructor(input: {
    provider: ProviderName;
    kind: ErrorKind;
    message: string;
    retryable?: boolean;
    status?: number;
    requestId?: string;
    retryAfterMs?: number;
    retryCount?: number;
    details?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = "WebProviderError";
    this.provider = input.provider;
    this.kind = input.kind;
    this.retryable = input.retryable ?? false;
    this.status = input.status;
    this.requestId = input.requestId;
    this.retryAfterMs = input.retryAfterMs;
    this.retryCount = input.retryCount ?? 0;
    this.details = input.details ?? {};
  }
}

export interface TransportDependencies {
  fetch: typeof globalThis.fetch;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  requestTimeoutMs: number;
  maxRetries: number;
  maxResponseBytes: number;
  maxRetryDelayMs: number;
  totalRequestTimeoutMs: number;
  monotonicNow: () => number;
}

export interface JsonTransportResponse<T> {
  response: Response;
  payload: T;
  retryCount: number;
}

function providerLabel(provider: ProviderName): string {
  return provider === "tavily" ? "Tavily" : "Exa";
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function responseRequestId(response: Response): string | undefined {
  for (const header of ["x-request-id", "request-id", "x-correlation-id"]) {
    const value = response.headers.get(header)?.trim();
    if (value && /^[A-Za-z0-9._:-]{1,200}$/.test(value)) return value;
  }
  return undefined;
}

function responseError(provider: ProviderName, response: Response, retryCount: number): WebProviderError {
  const status = response.status;
  const label = providerLabel(provider);
  const requestId = responseRequestId(response);
  if (status === 401) return new WebProviderError({ provider, kind: "authentication", message: `${label} authentication failed.`, status, requestId, retryCount });
  if (status === 402) return new WebProviderError({ provider, kind: "payment_or_quota", message: `${label} payment or quota check failed.`, status, requestId, retryCount });
  if (status === 403) return new WebProviderError({ provider, kind: "permission", message: `${label} permission was denied.`, status, requestId, retryCount });
  if (status === 404) return new WebProviderError({ provider, kind: "not_found", message: `${label} endpoint was not found.`, status, requestId, retryCount });
  if (status === 400 || status === 409 || status === 422) {
    return new WebProviderError({ provider, kind: "validation", message: `${label} rejected the request.`, status, requestId, retryCount });
  }
  if (status === 429) {
    return new WebProviderError({
      provider,
      kind: "rate_limit",
      message: `${label} rate limit was reached.`,
      status,
      retryable: true,
      retryAfterMs: retryAfterMs(response),
      requestId,
      retryCount,
    });
  }
  if (status >= 500) return new WebProviderError({ provider, kind: "upstream", message: `${label} upstream service failed.`, status, requestId, retryable: true, retryCount });
  return new WebProviderError({ provider, kind: "unknown", message: `${label} request failed with HTTP ${status}.`, status, requestId, retryCount });
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
}

function cancelled(provider: ProviderName, retryCount: number): WebProviderError {
  return new WebProviderError({ provider, kind: "cancelled", message: `${providerLabel(provider)} request was cancelled.`, retryCount });
}

function timeout(provider: ProviderName, retryCount: number): WebProviderError {
  return new WebProviderError({ provider, kind: "timeout", message: `${providerLabel(provider)} request timed out.`, retryable: true, retryCount });
}

function upstream(provider: ProviderName, retryCount: number): WebProviderError {
  return new WebProviderError({ provider, kind: "upstream", message: `${providerLabel(provider)} network request failed.`, retryable: true, retryCount });
}

async function boundedJson<T>(
  provider: ProviderName,
  response: Response,
  maxBytes: number,
  retryCount: number,
): Promise<T> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new WebProviderError({
      provider,
      kind: "safety-policy",
      message: `${providerLabel(provider)} response exceeded the byte safety limit.`,
      status: response.status,
      retryCount,
    });
  }
  if (!response.body) return JSON.parse("") as T;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new WebProviderError({
        provider,
        kind: "safety-policy",
        message: `${providerLabel(provider)} response exceeded the byte safety limit.`,
        status: response.status,
        retryCount,
      });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function delayFor(error: WebProviderError, attempt: number, maxDelayMs: number, remainingMs: number): number {
  const requested = error.retryAfterMs ?? Math.min(4_000, 250 * (2 ** attempt));
  return Math.max(0, Math.min(requested, maxDelayMs, remainingMs));
}

export async function requestJson<T>(
  provider: ProviderName,
  url: string,
  init: RequestInit,
  dependencies: TransportDependencies,
  callerSignal?: AbortSignal,
  operationDeadlineAt?: number,
): Promise<JsonTransportResponse<T>> {
  const startedAt = dependencies.monotonicNow();
  const deadlineAt = operationDeadlineAt ?? (dependencies.totalRequestTimeoutMs > 0
    ? startedAt + dependencies.totalRequestTimeoutMs
    : Number.POSITIVE_INFINITY);
  const remainingMs = () => Math.max(0, deadlineAt - dependencies.monotonicNow());
  for (let attempt = 0; ; attempt++) {
    if (callerSignal?.aborted) throw cancelled(provider, attempt);
    const remaining = remainingMs();
    if (remaining <= 0) throw timeout(provider, attempt);
    const attemptTimeout = dependencies.requestTimeoutMs > 0
      ? Math.min(dependencies.requestTimeoutMs, remaining)
      : remaining;
    const timeoutSignal = Number.isFinite(attemptTimeout) ? AbortSignal.timeout(Math.max(1, Math.floor(attemptTimeout))) : undefined;
    const signal = callerSignal && timeoutSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : (callerSignal ?? timeoutSignal);
    let firstAbortKind: "cancelled" | "timeout" | undefined;
    callerSignal?.addEventListener("abort", () => { firstAbortKind ??= "cancelled"; }, { once: true });
    timeoutSignal?.addEventListener("abort", () => { firstAbortKind ??= "timeout"; }, { once: true });
    const abortError = () => firstAbortKind === "cancelled"
      ? cancelled(provider, attempt)
      : firstAbortKind === "timeout" ? timeout(provider, attempt) : upstream(provider, attempt);
    let response: Response;
    try {
      response = await dependencies.fetch(url, { ...init, signal });
    } catch {
      const error = abortError();
      if (!error.retryable || attempt >= dependencies.maxRetries) throw error;
      try {
        await dependencies.sleep(delayFor(error, attempt, dependencies.maxRetryDelayMs, remainingMs()), callerSignal);
      } catch {
        throw cancelled(provider, attempt);
      }
      continue;
    }

    if (firstAbortKind) throw abortError();
    if (remainingMs() <= 0) throw timeout(provider, attempt);

    if (!response.ok) {
      const error = responseError(provider, response, attempt);
      if (!error.retryable || attempt >= dependencies.maxRetries) throw error;
      try {
        await dependencies.sleep(delayFor(error, attempt, dependencies.maxRetryDelayMs, remainingMs()), callerSignal);
      } catch {
        throw cancelled(provider, attempt);
      }
      continue;
    }

    try {
      const payload = await boundedJson<T>(provider, response, dependencies.maxResponseBytes, attempt);
      if (firstAbortKind) throw abortError();
      if (remainingMs() <= 0) throw timeout(provider, attempt);
      return { response, payload, retryCount: attempt };
    } catch (caught) {
      if (firstAbortKind) throw abortError();
      if (caught instanceof WebProviderError) throw caught;
      const error = new WebProviderError({
        provider,
        kind: "upstream",
        message: `${providerLabel(provider)} returned an invalid JSON response.`,
        retryable: true,
        status: response.status,
        retryCount: attempt,
      });
      if (attempt >= dependencies.maxRetries) throw error;
      try {
        await dependencies.sleep(delayFor(error, attempt, dependencies.maxRetryDelayMs, remainingMs()), callerSignal);
      } catch {
        throw cancelled(provider, attempt);
      }
    }
  }
}
