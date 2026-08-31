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

export function responseRequestId(response: Response): string | undefined {
  for (const header of ["x-request-id", "request-id", "x-correlation-id"]) {
    const value = response.headers.get(header)?.trim();
    if (value && /^[A-Za-z0-9._:-]{1,200}$/.test(value)) return value;
  }
  return undefined;
}

function withResponseMetadata(error: WebProviderError, response: Response, retryCount: number): WebProviderError {
  return new WebProviderError({
    provider: error.provider,
    kind: error.kind,
    message: error.message,
    retryable: error.retryable,
    status: error.status ?? response.status,
    requestId: error.requestId ?? responseRequestId(response),
    retryAfterMs: error.retryAfterMs,
    retryCount,
    details: error.details,
  });
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
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new DOMException("aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
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

function cancelResponseBody(response: Response): void {
  try { void response.body?.cancel().catch(() => {}); } catch { /* cancellation must not mask or delay the normalized failure */ }
}

async function boundedJson<T>(
  provider: ProviderName,
  response: Response,
  maxBytes: number,
  retryCount: number,
  signal?: AbortSignal,
  abortError?: () => WebProviderError,
): Promise<T> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await cancelResponseBody(response);
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
    const { done, value } = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const onAbort = () => {
        cleanup();
        try { void reader.cancel().catch(() => {}); } catch { /* untrusted cleanup is best effort */ }
        reject(abortError?.() ?? cancelled(provider, retryCount));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      reader.read().then(
        (result) => { cleanup(); resolve(result); },
        (error) => { cleanup(); reject(error); },
      );
    });
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { void reader.cancel().catch(() => {}); } catch { /* cleanup must not mask or delay the safety-policy failure */ }
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
  validatePayload?: (payload: unknown, retryCount: number) => unknown,
): Promise<JsonTransportResponse<T>> {
  const startedAt = dependencies.monotonicNow();
  const deadlineAt = operationDeadlineAt ?? (dependencies.totalRequestTimeoutMs > 0
    ? startedAt + dependencies.totalRequestTimeoutMs
    : Number.POSITIVE_INFINITY);
  const remainingMs = () => Math.max(0, deadlineAt - dependencies.monotonicNow());
  for (let attempt = 0; ; attempt++) {
    if (callerSignal?.aborted) throw cancelled(provider, attempt);
    let firstAbortKind: "cancelled" | "timeout" | undefined;
    const onCallerAbort = () => { firstAbortKind ??= "cancelled"; };
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    if (callerSignal?.aborted) firstAbortKind ??= "cancelled";
    const remaining = remainingMs();
    if (firstAbortKind === "cancelled") {
      callerSignal?.removeEventListener("abort", onCallerAbort);
      throw cancelled(provider, attempt);
    }
    if (remaining <= 0) {
      callerSignal?.removeEventListener("abort", onCallerAbort);
      throw timeout(provider, attempt);
    }
    const attemptTimeout = dependencies.requestTimeoutMs > 0
      ? Math.min(dependencies.requestTimeoutMs, remaining)
      : remaining;
    const timeoutSignal = Number.isFinite(attemptTimeout) ? AbortSignal.timeout(Math.max(1, Math.floor(attemptTimeout))) : undefined;
    const signal = callerSignal && timeoutSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : (callerSignal ?? timeoutSignal);
    const onTimeoutAbort = () => { firstAbortKind ??= "timeout"; };
    timeoutSignal?.addEventListener("abort", onTimeoutAbort, { once: true });
    if (timeoutSignal?.aborted) firstAbortKind ??= "timeout";
    const abortError = () => firstAbortKind === "cancelled"
      ? cancelled(provider, attempt)
      : firstAbortKind === "timeout" ? timeout(provider, attempt) : upstream(provider, attempt);
    try {
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

    if (firstAbortKind) {
      await cancelResponseBody(response);
      throw abortError();
    }
    if (remainingMs() <= 0) {
      await cancelResponseBody(response);
      throw timeout(provider, attempt);
    }

    if (!response.ok) {
      const error = responseError(provider, response, attempt);
      await cancelResponseBody(response);
      if (!error.retryable || attempt >= dependencies.maxRetries) throw error;
      try {
        await dependencies.sleep(delayFor(error, attempt, dependencies.maxRetryDelayMs, remainingMs()), callerSignal);
      } catch {
        throw cancelled(provider, attempt);
      }
      continue;
    }

    try {
      const decoded = await boundedJson<unknown>(provider, response, dependencies.maxResponseBytes, attempt, signal, abortError);
      const payload = (validatePayload ? validatePayload(decoded, attempt) : decoded) as T;
      if (firstAbortKind) throw abortError();
      if (remainingMs() <= 0) throw timeout(provider, attempt);
      return { response, payload, retryCount: attempt };
    } catch (caught) {
      const error = caught instanceof WebProviderError
        ? withResponseMetadata(caught, response, attempt)
        : caught;
      // Once the byte ceiling has been observed, best-effort body cleanup
      // cannot replace that authoritative safety failure with a later abort.
      if (error instanceof WebProviderError && error.kind === "safety-policy") throw error;
      if (error instanceof WebProviderError) {
        if (!error.retryable || attempt >= dependencies.maxRetries || remainingMs() <= 0) throw error;
        try {
          await dependencies.sleep(delayFor(error, attempt, dependencies.maxRetryDelayMs, remainingMs()), callerSignal);
        } catch {
          throw cancelled(provider, attempt);
        }
        continue;
      }
      if (firstAbortKind) throw abortError();
      const invalidJsonError = new WebProviderError({
        provider,
        kind: "upstream",
        message: `${providerLabel(provider)} returned an invalid JSON response.`,
        retryable: true,
        status: response.status,
        requestId: responseRequestId(response),
        retryCount: attempt,
      });
      if (attempt >= dependencies.maxRetries) throw invalidJsonError;
      try {
        await dependencies.sleep(delayFor(invalidJsonError, attempt, dependencies.maxRetryDelayMs, remainingMs()), callerSignal);
      } catch {
        throw cancelled(provider, attempt);
      }
    }
    } finally {
      callerSignal?.removeEventListener("abort", onCallerAbort);
      timeoutSignal?.removeEventListener("abort", onTimeoutAbort);
    }
  }
}
