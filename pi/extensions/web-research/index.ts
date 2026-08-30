import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OPTIONAL_SCHEMA = Symbol("optional-schema");
type JsonSchema = Record<string, unknown> & { [OPTIONAL_SCHEMA]?: true };
const Schema = {
  Object(properties: Record<string, JsonSchema>): JsonSchema {
    const required = Object.entries(properties)
      .filter(([, schema]) => !schema[OPTIONAL_SCHEMA])
      .map(([name]) => name);
    const cleanProperties = Object.fromEntries(
      Object.entries(properties).map(([name, schema]) => {
        const { [OPTIONAL_SCHEMA]: _optional, ...cleanSchema } = schema;
        return [name, cleanSchema];
      }),
    );
    return { type: "object", additionalProperties: false, ...(required.length ? { required } : {}), properties: cleanProperties };
  },
  String(options: Record<string, unknown> = {}): JsonSchema {
    return { type: "string", ...options };
  },
  Number(options: Record<string, unknown> = {}): JsonSchema {
    return { type: "number", ...options };
  },
  Array(items: JsonSchema, options: Record<string, unknown> = {}): JsonSchema {
    return { type: "array", items, ...options };
  },
  Optional(schema: JsonSchema): JsonSchema {
    return { ...schema, [OPTIONAL_SCHEMA]: true };
  },
};

export type ProviderName = "tavily" | "exa";
export type ProviderSelection = "auto" | ProviderName;
export type SearchProfile = "fast" | "balanced" | "thorough";
export type SearchIntent = "general" | "semantic" | "code";
export type ErrorKind = "authentication" | "payment_or_quota" | "permission" | "validation" | "rate_limit" | "timeout" | "not_found" | "upstream" | "cancelled" | "unknown";

export interface WebResearchDependencies {
  fetch: typeof globalThis.fetch;
  env: Record<string, string | undefined>;
  now: () => number;
}

const DEFAULT_DEPENDENCIES: WebResearchDependencies = {
  fetch: globalThis.fetch.bind(globalThis),
  env: process.env,
  now: Date.now,
};

export class WebProviderError extends Error {
  readonly provider: ProviderName;
  readonly kind: ErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryAfterMs?: number;

  constructor(input: {
    provider: ProviderName;
    kind: ErrorKind;
    message: string;
    retryable?: boolean;
    status?: number;
    requestId?: string;
    retryAfterMs?: number;
  }) {
    super(input.message);
    this.name = "WebProviderError";
    this.provider = input.provider;
    this.kind = input.kind;
    this.retryable = input.retryable ?? false;
    this.status = input.status;
    this.requestId = input.requestId;
    this.retryAfterMs = input.retryAfterMs;
  }
}

interface SearchInput {
  query: string;
  maxResults: number;
  profile: SearchProfile;
  provider: ProviderSelection;
  intent: SearchIntent;
  includeDomains: string[];
  excludeDomains: string[];
  publishedAfter?: string;
  publishedBefore?: string;
}

interface WebDocument {
  title: string;
  url: string;
  snippets: string[];
  publishedAt?: string;
  author?: string;
  score?: number;
}

interface ProviderSearchResponse {
  provider: ProviderName;
  resolvedMode: string;
  status: number;
  requestId?: string;
  documents: WebDocument[];
}

interface SearchAttempt {
  provider: ProviderName;
  outcome: "success" | "empty" | "error";
  status?: number;
  errorKind?: ErrorKind;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, fallback: T, allowed: readonly T[], field: string): T {
  if (value === undefined) return fallback;
  if (typeof value === "string" && allowed.includes(value as T)) return value as T;
  throw new Error(`${field} must be one of: ${allowed.join(", ")}.`);
}

function requiredQuery(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("query is required.");
  const query = value.trim();
  if (query.length > 2_000) throw new Error("query must not exceed 2000 characters.");
  return query;
}

function domainList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error(`${field} must be an array of at most 20 domains.`);
  const domains = value.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`${field} must contain non-empty domain strings.`);
    const domain = item.trim().toLowerCase();
    if (domain.length > 253 || /[\s/@]/.test(domain)) throw new Error(`${field} contains an invalid domain.`);
    return domain;
  });
  return [...new Set(domains)];
}

function publishedDate(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be an ISO 8601 date or timestamp.`);
  }
  return value.trim();
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numericValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function tavilyMode(profile: SearchProfile): "fast" | "basic" | "advanced" {
  if (profile === "fast") return "fast";
  if (profile === "thorough") return "advanced";
  return "basic";
}

function exaMode(profile: SearchProfile): "fast" | "auto" | "deep-lite" {
  if (profile === "fast") return "fast";
  if (profile === "thorough") return "deep-lite";
  return "auto";
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

function errorForResponse(provider: ProviderName, response: Response): WebProviderError {
  const status = response.status;
  const label = providerLabel(provider);
  if (status === 401) return new WebProviderError({ provider, kind: "authentication", message: `${label} authentication failed.`, status });
  if (status === 402) return new WebProviderError({ provider, kind: "payment_or_quota", message: `${label} payment or quota check failed.`, status });
  if (status === 403) return new WebProviderError({ provider, kind: "permission", message: `${label} permission was denied.`, status });
  if (status === 404) return new WebProviderError({ provider, kind: "not_found", message: `${label} endpoint was not found.`, status });
  if (status === 400 || status === 409 || status === 422) {
    return new WebProviderError({ provider, kind: "validation", message: `${label} rejected the request.`, status });
  }
  if (status === 429) {
    return new WebProviderError({ provider, kind: "rate_limit", message: `${label} rate limit was reached.`, status, retryable: true, retryAfterMs: retryAfterMs(response) });
  }
  if (status >= 500) return new WebProviderError({ provider, kind: "upstream", message: `${label} upstream service failed.`, status, retryable: true });
  return new WebProviderError({ provider, kind: "unknown", message: `${label} request failed with HTTP ${status}.`, status });
}

function formatSearchResults(results: WebDocument[]): string {
  if (results.length === 0) return "No web search results.";
  return results.map((result, index) => [
    `${index + 1}. ${result.title}`,
    `   URL: ${result.url}`,
    ...(result.publishedAt ? [`   Published: ${result.publishedAt}`] : []),
    ...(result.author ? [`   Author: ${result.author}`] : []),
    `   Evidence: ${result.snippets.length ? result.snippets.join(" […] ") : "No extractive snippet returned."}`,
  ].join("\n")).join("\n\n");
}

async function searchTavily(input: SearchInput, dependencies: WebResearchDependencies, signal?: AbortSignal): Promise<ProviderSearchResponse> {
  const apiKey = dependencies.env.TAVILY_API_KEY;
  if (!apiKey) throw new WebProviderError({ provider: "tavily", kind: "authentication", message: "Tavily authentication is not configured (set TAVILY_API_KEY)." });
  const resolvedMode = tavilyMode(input.profile);
  const response = await dependencies.fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: input.query,
      max_results: input.maxResults,
      search_depth: resolvedMode,
      include_raw_content: false,
      ...(input.includeDomains.length ? { include_domains: input.includeDomains } : {}),
      ...(input.excludeDomains.length ? { exclude_domains: input.excludeDomains } : {}),
      ...(input.publishedAfter ? { start_date: input.publishedAfter.slice(0, 10) } : {}),
      ...(input.publishedBefore ? { end_date: input.publishedBefore.slice(0, 10) } : {}),
    }),
    signal,
  });
  if (!response.ok) throw errorForResponse("tavily", response);
  const payload = await response.json() as { request_id?: unknown; results?: unknown };
  const documents = Array.isArray(payload.results)
    ? payload.results.flatMap((value): WebDocument[] => {
      if (!value || typeof value !== "object") return [];
      const result = value as Record<string, unknown>;
      const url = textValue(result.url);
      if (!url) return [];
      const snippet = textValue(result.content);
      return [{
        title: textValue(result.title) ?? "Untitled result",
        url,
        snippets: snippet ? [snippet] : [],
        publishedAt: textValue(result.published_date),
        score: numericValue(result.score),
      }];
    })
    : [];
  return { provider: "tavily", resolvedMode, status: response.status, requestId: textValue(payload.request_id), documents };
}

async function searchExa(input: SearchInput, dependencies: WebResearchDependencies, signal?: AbortSignal): Promise<ProviderSearchResponse> {
  const apiKey = dependencies.env.EXA_API_KEY;
  if (!apiKey) throw new WebProviderError({ provider: "exa", kind: "authentication", message: "Exa authentication is not configured (set EXA_API_KEY)." });
  const resolvedMode = exaMode(input.profile);
  const response = await dependencies.fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      query: input.query,
      numResults: input.maxResults,
      type: resolvedMode,
      contents: { highlights: { maxCharacters: 2_000 } },
      ...(input.includeDomains.length ? { includeDomains: input.includeDomains } : {}),
      ...(input.excludeDomains.length ? { excludeDomains: input.excludeDomains } : {}),
      ...(input.publishedAfter ? { startPublishedDate: input.publishedAfter } : {}),
      ...(input.publishedBefore ? { endPublishedDate: input.publishedBefore } : {}),
    }),
    signal,
  });
  if (!response.ok) throw errorForResponse("exa", response);
  const payload = await response.json() as { requestId?: unknown; results?: unknown };
  const documents = Array.isArray(payload.results)
    ? payload.results.flatMap((value): WebDocument[] => {
      if (!value || typeof value !== "object") return [];
      const result = value as Record<string, unknown>;
      const url = textValue(result.url);
      if (!url) return [];
      const snippets = Array.isArray(result.highlights)
        ? result.highlights.flatMap((item) => textValue(item) ? [textValue(item)!] : [])
        : [];
      return [{
        title: textValue(result.title) ?? "Untitled result",
        url,
        snippets,
        publishedAt: textValue(result.publishedDate),
        author: textValue(result.author),
      }];
    })
    : [];
  return { provider: "exa", resolvedMode, status: response.status, requestId: textValue(payload.requestId), documents };
}

function initialProvider(input: SearchInput): ProviderName {
  if (input.provider !== "auto") return input.provider;
  return input.intent === "semantic" || input.intent === "code" ? "exa" : "tavily";
}

async function executeSearch(
  input: SearchInput,
  dependencies: WebResearchDependencies,
  signal: AbortSignal | undefined,
  onUpdate: ((update: any) => void) | undefined,
): Promise<{ response: ProviderSearchResponse; attempts: SearchAttempt[] }> {
  const selected = initialProvider(input);
  const attempts: SearchAttempt[] = [];
  const run = async (provider: ProviderName): Promise<ProviderSearchResponse> => {
    onUpdate?.({ content: [{ type: "text", text: `Searching ${providerLabel(provider)}…` }], details: { provider } });
    try {
      const response = provider === "tavily"
        ? await searchTavily(input, dependencies, signal)
        : await searchExa(input, dependencies, signal);
      attempts.push({ provider, outcome: response.documents.length ? "success" : "empty", status: response.status });
      return response;
    } catch (error) {
      if (error instanceof WebProviderError) attempts.push({ provider, outcome: "error", status: error.status, errorKind: error.kind });
      throw error;
    }
  };

  let first: ProviderSearchResponse;
  try {
    first = await run(selected);
  } catch (error) {
    const mayFallbackAfterError = input.provider === "auto"
      && selected === "tavily"
      && error instanceof WebProviderError
      && error.retryable
      && Boolean(dependencies.env.EXA_API_KEY);
    if (mayFallbackAfterError) return { response: await run("exa"), attempts };
    throw error;
  }
  const mayFallback = input.provider === "auto" && selected === "tavily" && first.documents.length === 0 && Boolean(dependencies.env.EXA_API_KEY);
  if (mayFallback) return { response: await run("exa"), attempts };
  return { response: first, attempts };
}

export default function webResearch(
  pi: Pick<ExtensionAPI, "registerTool">,
  overrides: Partial<WebResearchDependencies> = {},
): void {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search public web sources through the first-party Tavily/Exa research harness.",
    promptSnippet: "Search the public web for compact source-linked evidence. Tavily is the ordinary default.",
    promptGuidelines: [
      "Use web_search to discover sources; fetch material sources before treating snippets as confirmed evidence.",
      "Use the bundled my-web-search skill or delegate to Ciung for multi-source or iterative research.",
    ],
    executionMode: "parallel",
    parameters: Schema.Object({
      query: Schema.String({ minLength: 1, maxLength: 2_000, description: "Public-web search query." }),
      provider: Schema.Optional(Schema.String({ enum: ["auto", "tavily", "exa"], description: "Provider override; defaults to auto." })),
      intent: Schema.Optional(Schema.String({ enum: ["general", "semantic", "code"], description: "Declared search intent. Semantic and code route auto searches to Exa." })),
      maxResults: Schema.Optional(Schema.Number({ minimum: 1, maximum: 20, description: "Result count; defaults to 5." })),
      profile: Schema.Optional(Schema.String({ enum: ["fast", "balanced", "thorough"], description: "Advisory speed/depth profile." })),
      includeDomains: Schema.Optional(Schema.Array(Schema.String(), { maxItems: 20, description: "Only include these public domains." })),
      excludeDomains: Schema.Optional(Schema.Array(Schema.String(), { maxItems: 20, description: "Exclude these domains." })),
      publishedAfter: Schema.Optional(Schema.String({ description: "Best-effort ISO 8601 publication lower bound." })),
      publishedBefore: Schema.Optional(Schema.String({ description: "Best-effort ISO 8601 publication upper bound." })),
    }) as any,
    async execute(_toolCallId, params, signal, onUpdate) {
      const raw = params as Record<string, unknown>;
      const input: SearchInput = {
        query: requiredQuery(raw.query),
        maxResults: boundedInteger(raw.maxResults, 5, 1, 20, "maxResults"),
        profile: enumValue(raw.profile, "balanced", ["fast", "balanced", "thorough"] as const, "profile"),
        provider: enumValue(raw.provider, "auto", ["auto", "tavily", "exa"] as const, "provider"),
        intent: enumValue(raw.intent, "general", ["general", "semantic", "code"] as const, "intent"),
        includeDomains: domainList(raw.includeDomains, "includeDomains"),
        excludeDomains: domainList(raw.excludeDomains, "excludeDomains"),
        publishedAfter: publishedDate(raw.publishedAfter, "publishedAfter"),
        publishedBefore: publishedDate(raw.publishedBefore, "publishedBefore"),
      };
      const startedAt = dependencies.now();
      const { response, attempts } = await executeSearch(input, dependencies, signal, onUpdate);
      return {
        content: [{ type: "text", text: formatSearchResults(response.documents) }],
        details: {
          provider: response.provider,
          resolvedMode: response.resolvedMode,
          attempts,
          resultCount: response.documents.length,
          requestId: response.requestId,
          durationMs: Math.max(0, dependencies.now() - startedAt),
          cacheHit: false,
          truncated: false,
        },
      };
    },
  } as any);
}
