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
  Optional(schema: JsonSchema): JsonSchema {
    return { ...schema, [OPTIONAL_SCHEMA]: true };
  },
};

export type SearchProfile = "fast" | "balanced" | "thorough";

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

interface TavilyResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  score?: unknown;
  published_date?: unknown;
}

interface TavilyResponse {
  request_id?: unknown;
  results?: unknown;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function searchDepth(profile: unknown): "fast" | "basic" | "advanced" {
  if (profile === undefined || profile === "balanced") return "basic";
  if (profile === "fast" || profile === "thorough") return profile === "fast" ? "fast" : "advanced";
  throw new Error("profile must be fast, balanced, or thorough.");
}

function requiredQuery(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("query is required.");
  const query = value.trim();
  if (query.length > 2_000) throw new Error("query must not exceed 2000 characters.");
  return query;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatSearchResults(results: TavilyResult[]): string {
  if (results.length === 0) return "No web search results.";
  return results.map((result, index) => {
    const title = textValue(result.title) ?? "Untitled result";
    const url = textValue(result.url) ?? "URL unavailable";
    const evidence = textValue(result.content) ?? "No extractive snippet returned.";
    const published = textValue(result.published_date);
    return [
      `${index + 1}. ${title}`,
      `   URL: ${url}`,
      ...(published ? [`   Published: ${published}`] : []),
      `   Evidence: ${evidence}`,
    ].join("\n");
  }).join("\n\n");
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
      maxResults: Schema.Optional(Schema.Number({ minimum: 1, maximum: 20, description: "Result count; defaults to 5." })),
      profile: Schema.Optional(Schema.String({ enum: ["fast", "balanced", "thorough"], description: "Advisory speed/depth profile." })),
    }) as any,
    async execute(_toolCallId, params, signal, onUpdate) {
      const query = requiredQuery((params as { query?: unknown }).query);
      const maxResults = boundedInteger((params as { maxResults?: unknown }).maxResults, 5, 1, 20, "maxResults");
      const resolvedMode = searchDepth((params as { profile?: unknown }).profile);
      const apiKey = dependencies.env.TAVILY_API_KEY;
      if (!apiKey) throw new Error("Tavily authentication is not configured (set TAVILY_API_KEY).");

      onUpdate?.({
        content: [{ type: "text", text: "Searching Tavily…" }],
        details: { provider: "tavily", resolvedMode },
      });
      const startedAt = dependencies.now();
      const response = await dependencies.fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query,
          max_results: maxResults,
          search_depth: resolvedMode,
          include_raw_content: false,
        }),
        signal,
      });
      if (!response.ok) throw new Error(`Tavily search failed with HTTP ${response.status}.`);
      const payload = await response.json() as TavilyResponse;
      const results = Array.isArray(payload.results)
        ? payload.results.filter((item): item is TavilyResult => Boolean(item && typeof item === "object"))
        : [];

      return {
        content: [{ type: "text", text: formatSearchResults(results) }],
        details: {
          provider: "tavily",
          resolvedMode,
          attempts: [{ provider: "tavily", outcome: "success", status: response.status }],
          resultCount: results.length,
          requestId: textValue(payload.request_id),
          durationMs: Math.max(0, dependencies.now() - startedAt),
          cacheHit: false,
          truncated: false,
        },
      };
    },
  } as any);
}
