export type ProviderName = "tavily" | "exa";
export type ErrorKind =
  | "authentication"
  | "payment_or_quota"
  | "permission"
  | "validation"
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

  constructor(input: {
    provider: ProviderName;
    kind: ErrorKind;
    message: string;
    retryable?: boolean;
    status?: number;
    requestId?: string;
    retryAfterMs?: number;
    retryCount?: number;
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
  }
}

export interface TransportDependencies {
  fetch: typeof globalThis.fetch;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  requestTimeoutMs: number;
  maxRetries: number;
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

function responseError(provider: ProviderName, response: Response, retryCount: number): WebProviderError {
  const status = response.status;
  const label = providerLabel(provider);
  if (status === 401) return new WebProviderError({ provider, kind: "authentication", message: `${label} authentication failed.`, status, retryCount });
  if (status === 402) return new WebProviderError({ provider, kind: "payment_or_quota", message: `${label} payment or quota check failed.`, status, retryCount });
  if (status === 403) return new WebProviderError({ provider, kind: "permission", message: `${label} permission was denied.`, status, retryCount });
  if (status === 404) return new WebProviderError({ provider, kind: "not_found", message: `${label} endpoint was not found.`, status, retryCount });
  if (status === 400 || status === 409 || status === 422) {
    return new WebProviderError({ provider, kind: "validation", message: `${label} rejected the request.`, status, retryCount });
  }
  if (status === 429) {
    return new WebProviderError({
      provider,
      kind: "rate_limit",
      message: `${label} rate limit was reached.`,
      status,
      retryable: true,
      retryAfterMs: retryAfterMs(response),
      retryCount,
    });
  }
  if (status >= 500) return new WebProviderError({ provider, kind: "upstream", message: `${label} upstream service failed.`, status, retryable: true, retryCount });
  return new WebProviderError({ provider, kind: "unknown", message: `${label} request failed with HTTP ${status}.`, status, retryCount });
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

function delayFor(error: WebProviderError, attempt: number): number {
  return error.retryAfterMs ?? Math.min(4_000, 250 * (2 ** attempt));
}

export async function requestJson<T>(
  provider: ProviderName,
  url: string,
  init: RequestInit,
  dependencies: TransportDependencies,
  callerSignal?: AbortSignal,
): Promise<JsonTransportResponse<T>> {
  for (let attempt = 0; ; attempt++) {
    if (callerSignal?.aborted) throw cancelled(provider, attempt);
    const timeoutSignal = dependencies.requestTimeoutMs > 0 ? AbortSignal.timeout(dependencies.requestTimeoutMs) : undefined;
    const signal = callerSignal && timeoutSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : (callerSignal ?? timeoutSignal);
    let response: Response;
    try {
      response = await dependencies.fetch(url, { ...init, signal });
    } catch {
      const error = callerSignal?.aborted
        ? cancelled(provider, attempt)
        : timeoutSignal?.aborted ? timeout(provider, attempt) : upstream(provider, attempt);
      if (!error.retryable || attempt >= dependencies.maxRetries) throw error;
      try {
        await dependencies.sleep(delayFor(error, attempt), callerSignal);
      } catch {
        throw cancelled(provider, attempt);
      }
      continue;
    }

    if (callerSignal?.aborted) throw cancelled(provider, attempt);

    if (!response.ok) {
      const error = responseError(provider, response, attempt);
      if (!error.retryable || attempt >= dependencies.maxRetries) throw error;
      try {
        await dependencies.sleep(delayFor(error, attempt), callerSignal);
      } catch {
        throw cancelled(provider, attempt);
      }
      continue;
    }

    try {
      const payload = await response.json() as T;
      if (callerSignal?.aborted) throw cancelled(provider, attempt);
      return { response, payload, retryCount: attempt };
    } catch {
      if (callerSignal?.aborted) throw cancelled(provider, attempt);
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
        await dependencies.sleep(delayFor(error, attempt), callerSignal);
      } catch {
        throw cancelled(provider, attempt);
      }
    }
  }
}
